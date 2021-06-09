const axios = require('axios')
const _ = require('lodash')
const glob = require('glob-promise')
const aguid = require('aguid')
const { v1: uuidv1 } = require('uuid')
const hasha = require('hasha')
const fs = require('fs-extra-promise')
const path = require('path')
const FormData = require('form-data')
const Promise = require('bluebird')
const os = require('os')
const Queue = require('queue')
const cluster = require('cluster')
const { throttle } = require('throttle-debounce')
const { flockAsync } = Promise.promisifyAll(require('fs-ext'))	
const { machineIdSync } = require('node-machine-id')

module.exports = function (mikser, context) {
	const machineId = machineIdSync() + '_' + os.hostname() + '_' + os.userInfo().username
	let config = mikser.config['whitebox']
	let options = _.defaultsDeep(
		config || {
			services: {
				feed: {
					url: 'https://feed.whitebox.pro',
				},
				storage: {
					url: 'https://storage.whitebox.pro',
				},
			},
		}
	)
	if (cluster.isMaster) {
		mikser.cli.option('-wc, --whitebox-clear', 'clear WhiteBox documents').init()
		mikser.cli.option('-wr, --whitebox-refresh', 'refresh WhiteBox documents').init()
		mikser.cli.option('-wg, --whitebox-global', 'use WhiteBox global context').init()

		if (mikser.cli.whiteboxClear) {
			options.clear = true
		}
		if (mikser.cli.whiteboxRefresh) {
			options.refresh = true
		}
		if (mikser.cli.whiteboxGlobal) {
			options.global = true
		}
	}

	if (!options.services.feed.token) {
		console.error('WhtieBox feed token is missing.')
		return Promise.resolve()
	}

	if (!options.global) {
		options.expire = options.expire || '10 days'
		console.log('Expire:', options.expire)
	}

	let pendingUploads = {}
	let plugin = {
		api(service, url, data) {
			return axios
				.post(options.services[service].url + url + '?v=' + Date.now(), data, {
					headers: {
						Authorization: 'Bearer ' + options.services[service].token,
					},
				})
				.then((response) => {
					if (response.data.success) {
						return Promise.resolve(response.data)
					} else {
						console.error('Api service error:', url, data, response.data.message)
						return Promise.reject(response.data.message)
					}
				})
				.catch((err) => {
					console.error('Api system error:', url, data, err)
					return Promise.resolve()
				})
		},
		upload(file) {
			if (pendingUploads[file]) return Promise.resolve()
			pendingUploads[file] = true
			return fs.openAsync(file, 'r').then(fd => {
				return flockAsync(fd, 'sh').then(() => {
					// mikser.diagnostics.log(this, 'debug', `[whitebox] File locked: ${file}`)
					let relative = file.replace(mikser.config.outputFolder, '')
					let data = {
						file: relative
					}
					if (!options.global) data.context = machineId
					return axios
					.post(options.services.storage.url + '/' + options.services.storage.token + '/hash', data)
					.then((response) => {
						return hasha.fromFile(file, { algorithm: 'md5' }).then((hash) => {
								// mikser.diagnostics.log(this, 'debug', `[whitebox] MD5: ${file} ${hash} ${response.data.hash}`)
								if (!response.data.success || hash != response.data.hash) {
									let uploadHeaders = {}
									if (!options.global) {
										uploadHeaders = {
											expire: options.expire,
											context: machineId
										}
									}
									let form = new FormData()
									form.append(relative, fs.createReadStream(file))
									let formHeaders = form.getHeaders()
									return axios
										.post(options.services.storage.url + '/upload', form, {
											headers: {
												Authorization: 'Bearer ' + options.services.storage.token,
												...formHeaders,
												...uploadHeaders,
											},
											maxContentLength: Infinity,
											maxBodyLength: Infinity
										})
										.then((response) => {
											for (let file in response.uploads) {
												console.log(
													'📦', file, 
													'🔗', response.uploads[file]
												)
											}
										})
										.catch((err) => console.error('Error uplaoding:', err))									
								}
							})
						})
						.then(() => {
							return flockAsync(fd, 'un')
						})
						.catch(err => {
							console.error(err)
							return flockAsync(fd, 'un')
						})
				}).catch(err => {
					console.error('Lock failed:', file, err)
				})
			}).then(() => delete pendingUploads[file])
		},
		unlink(file) {
			let relative = file.replace(mikser.config.filesFolder, '')
			let data = {
				file: relative
			}
			if (!options.global) data.context = machineId
			return axios
			.post(options.services.storage.url + '/' + options.services.storage.token + '/unlink', data)
			.then(() => {
				console.log('🗑️', relative)
				return fs.unlinkAsync(path.join(mikser.config.outputFolder, relative))
			})
		}
	}

	const clearCache = throttle(1000, () => {
		console.log('Clear cache')
		let data = {}
		if (!options.global) data.context = machineId
		return plugin.api('feed', '/api/catalog/clear/cache', data, options)
	})

	if (!context) {
		let clear = Promise.resolve()
		if (options.clear || options.refresh) {
			console.log('Clear whtiebox data')
			let data = {}
			if (!options.global) data.context = machineId
			clear = plugin.api('feed', '/api/catalog/clear', data)
				.then(() => {
					if (options.clear) {
						return axios.post(options.services.storage.url + '/' + options.services.storage.token + '/clear', {})
					}
				})
				.catch((err) => console.error('Error clearing:', err))
		}
		let queue = Queue({
			concurrency: 3,
			autostart: true
		})

		mikser.on('mikser.manager.importDocument', (document) => {
			if (document.meta.target != 'whitebox' || !document.meta.layout) return Promise.resolve()
			document.render = false
			let data = {
				passportId: uuidv1(),
				vaultId: aguid(document._id),
				refId: document.url.replace('/index.html', '') || '/',
				type: document.meta.layout,
				data: _.pick(document, ['meta', 'stamp', 'importDate']),
				date: document.mtime,
			}
			if (!options.global) {
				data.context = machineId
				data.expire = options.expire
			}
			if (mikser.config.shared) {
				for (let share of mikser.config.shared) {
					if (data.refId.indexOf(share) == 1) {
						data.share = share
						data.refId = data.refId.replace('/' + share, '') || '/'
						break
					}
				}
			}
			if (!options.clear) {
				queue.push(() => {
					clearCache()
					console.log('✔️', data.refId)
					return plugin.api('feed', '/api/catalog/keep/one', data, options)
				})
			}
		})

		mikser.on('mikser.manager.deleteDocument', (document) => {
			if (document.meta.target != 'whitebox' || !document.meta.layout) return Promise.resolve()
			console.log('Removing vault:', document._id)
			let data = {
				vaultId: aguid(document._id),
			}
			if (!options.global) data.context = machineId
			if (!options.clear) {
				queue.push(() => {
					clearCache()
					console.log('🗑️', document._id)
					return plugin.api('feed', '/api/catalog/remove', data, options)
				})
			}
		})

		mikser.on('mikser.manager.sync', async () => {
			if (!options.clear) {
				let files = await glob('storage/**/*', { cwd: mikser.config.outputFolder })
				for (let file of files) {
					file = path.join(mikser.config.outputFolder, file)
					const stat = await fs.lstatAsync(file)
					if (stat.isFile()) {
						await plugin.upload(file)
					}
				}
			}
		})

		mikser.on('mikser.watcher.fileAction', async (event, file) => {
			if (event == 'unlink' && file.indexOf('storage') != -1) {
				await plugin.unlink(file)
			}
		})

		return clear.then(() => plugin)
	}
}
