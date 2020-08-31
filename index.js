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
const Queue = require('queue')
const cluster = require('cluster')
const { throttle } = require('throttle-debounce')
const { flockAsync } = Promise.promisifyAll(require('fs-ext'))	

module.exports = function (mikser, context) {
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
		if (mikser.cli.whiteboxClear) {
			options.clear = true
		}
		if (mikser.cli.whiteboxRefresh) {
			option.refresh = true
		}
	}

	if (!options.services.feed.token) {
		console.error('WhtieBox feed token is missing.')
		return Promise.resolve()
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
					return axios
					.post(options.services.storage.url + '/' + options.services.storage.token + '/hash', {
						file: relative,
					})
					.then((response) => {
						return hasha.fromFile(file, { algorithm: 'md5' }).then((hash) => {
								// mikser.diagnostics.log(this, 'debug', `[whitebox] MD5: ${file} ${hash} ${response.data.hash}`)
								if (!response.data.success || hash != response.data.hash) {
									let form = new FormData()
									form.append(relative, fs.createReadStream(file))
									const submit = Promise.promisify(form.submit, { context: form })
									return submit(options.services.storage.url + '/' + options.services.storage.token + '/upload')
										.then((res) => {
											console.log('📦 Uploaded:', file, res.statusCode, res.statusMessage)
											res.resume()
										})
										.catch((err) => console.error('Error uplaoding:', err))
								}
							})
						})
						.then(() => {
							return flockAsync(fd, 'un')
						})
						.catch(() => {
							return flockAsync(fd, 'un')
						})
				}).catch(err => {
					console.error('Lock failed:', file, err)
				})
			}).then(() => delete pendingUploads[file])
		}
	
	}

	const clearCache = throttle(1000, () => {
		console.log('Clear cache')
		return plugin.api('feed', '/api/vault/clear/cache', {}, options)
	})

	if (!context) {
		let clear = Promise.resolve()
		if (options.clear || options.refresh) {
			console.log('Clear whtiebox data')
			clear = plugin.api('feed', '/api/vault/clear', {})
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
			if (!document.meta.layout) return Promise.resolve()
			document.render = false
			let data = {
				passportId: uuidv1(),
				vaultId: aguid(document._id),
				refId: document.url.replace('/index.html', '') || '/',
				type: document.meta.layout,
				data: _.pick(document, ['meta', 'stamp', 'importDate']),
				stamp: document.stamp,
				date: document.mtime,
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
					console.log('✔️ Keep:', data.refId)
					return plugin.api('feed', '/api/vault/keep/one', data, options)
				})
			}
		})

		mikser.on('mikser.manager.deleteDocument', (document) => {
			console.log('Removing vault:', document._id)
			let data = {
				vaultId: aguid(document._id),
			}
			if (!options.clear) {
				queue.push(() => {
					clearCache()
					console.log('🗑️ Deleted:', document._id)
					return plugin.api('feed', '/api/vault/remove', data, options)
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
			let relative = file.replace(mikser.config.filesFolder, '')
			if (event == 'unlink' && relative.indexOf('storage') != -1) {
				return axios
				.post(options.services.storage.url + '/' + options.services.storage.token + '/unlink', {
					file: relative,
				})
				.then(() => {
					console.log('🗑️ Deleted:', relative)
					return fs.unlinkAsync(path.join(mikser.config.outputFolder, relative))
				})
			}
		})

		return clear.then(() => plugin)
	}
}
