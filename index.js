const axios = require('axios')
const _ = require('lodash')
const glob = require('glob-promise');
const aguid = require('aguid')
const { v1: uuidv1 } = require('uuid')
const hasha = require('hasha')
var fs = require("fs-extra-promise");
const path = require('path')
const FormData = require('form-data')
const Promise = require('bluebird')

module.exports = function (mikser, context) {
	let config = mikser.config['whitebox']
	let options = _.defaultsDeep(
		config || {
			services: {
				data: {
					url: 'https://data.whitebox.pro',
				},
				storage: {
					url: 'https://storage.whitebox.pro',
				},
			},
		}
    )
	if (!options.services.data.token) {
		console.error('WhtieBox data token is missing.')
		return Promise.resolve()
	}

	function api(service, url, data) {
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
	}

	function upload(file) {
		console.log('Checking md5:', file)
		let relative = file.replace(mikser.config.outputFolder, '')
		return axios
			.post(
				options.services.storage.url +
					'/' +
					options.services.storage.token +
					'/hash',
				{
					file: relative,
				}
			)
			.then((response) => {
				return hasha.fromFile(file, { algorithm: 'md5' }).then((hash) => {
					console.log('MD5:', hash, response.data.hash)
					if (!response.data.success || hash != response.data.hash) {
						console.log('Uploading:', file)
						let form = new FormData()
						form.append(relative, fs.createReadStream(file))
						const submit = Promise.promisify(form.submit, { context: form })
						return submit(
							options.services.storage.url +
								'/' +
								options.services.storage.token +
								'/upload'
						)
							.then((res) => {
								console.log(
									'Uploaded:',
									file,
									res.statusCode,
									res.statusMessage
								)
								res.resume()
							})
							.catch((err) => console.error('Error uplaoding:', err))
					}
				})
			})
	}

	if (!context) {
		mikser.on('mikser.manager.importDocument', (document) => {
			if (!document.meta.type && !document.meta.layout) return Promise.resolve()
			document.render = false
			let data = {
				passportId: uuidv1(),
				vaultId: aguid(document._id),
				refId: document.url.replace('/index.html', '') || '/',
				type: document.meta.type || document.meta.layout,
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
			return api('data', '/api/vault/keep/one', data, options)
		})
		mikser.on('mikser.manager.deleteDocument', (document) => {
			console.log('Removing vault:', document._id)
			let data = {
				vaultId: aguid(document._id),
			}
			return api('data', '/api/vault/remove', data, options)
		})

        mikser.on('mikser.manager.sync', async () => {
            let files = await glob('storage/**/*', { cwd: mikser.config.outputFolder })
            for (let file of files) {
				file = path.join(mikser.config.outputFolder, file)
                console.log('WhiteBox sync:', file)
                const stat = await fs.lstatAsync(file)
                if (stat.isFile()) {
                    await upload(file)
                }
            }
		})

		if (options.clear) {
			return api('data', '/api/vault/clear', {})
				.then(() => {
					return axios.post(
						options.services.storage.url +
							'/' +
							options.services.storage.token +
							'/clear',
						{}
					)
				})
				.catch((err) => console.error('Error clearing:', err))
		}
	}
}
