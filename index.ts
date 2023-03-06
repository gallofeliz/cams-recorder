import { runApp } from '@gallofeliz/application'
import { HttpServer } from '@gallofeliz/http-server'
import { runProcess } from '@gallofeliz/run-process'
import { tsToJsSchema } from '@gallofeliz/typescript-transform-to-json-schema'
// @ts-ignore
import { OnvifDevice } from 'node-onvif'
import { setTimeout as wait } from 'timers/promises'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import dayjs from 'dayjs'
import { dirname } from 'path'
import Jimp from 'jimp'

interface Config {
    camera: {
        onvifUrl: string
        user: string
        pass: string
    }
    //uri: string
    /** @default 80 */
    port: number
}

class Camera {
    protected onvifDevice: OnvifDevice

    constructor({onvifUrl, user, pass}: any) {
        this.onvifDevice = new OnvifDevice({
          xaddr: onvifUrl,
          user,
          pass
        })
    }

    protected async init() {
        await this.onvifDevice.init()
    }

    async getRtspUrl() {
        const profile = await this.onvifDevice.getCurrentProfile()
        return profile.stream.rtsp.replace('rtsp://', 'rtsp://viewer:viewer@')
    }

    async gotoMainPosition() {
        await this.init()

        await this.onvifDevice.services.ptz.gotoPreset({
            ProfileToken: (await this.onvifDevice.getCurrentProfile()).token,
            PresetToken: '3',
            Speed: { x: 0.5, y: 0.5, z: 0.5 }
        })
        await wait(8000)
    }

    async gotoSecretPosition() {
        await this.init()

        await this.onvifDevice.services.ptz.gotoPreset({
            ProfileToken: (await this.onvifDevice.getCurrentProfile()).token,
            PresetToken: '2',
            Speed: { x: 0.5, y: 0.5, z: 0.5 }
        })
        await wait(8000)
    }

}

let session: any

async function snapshot({abortSignal, logger, url}: any) {
    const vars = {
        date: dayjs().format('YYYY-MM-DD'),
        datetime: dayjs().format('YYYY-MM-DDTHH:mm:ss')
    }

    const path = '/data/cam1/'+vars.date+'/'+vars.datetime+'.jpg'
    const thumbPath = '/data/cam1/'+vars.date+'/thumbs/'+vars.datetime+'.jpg'

    await mkdir(dirname(thumbPath), {recursive: true})

    await rtspToJpeg({
        stream: createWriteStream(
            path,
            { encoding: 'binary' }
        ),
        abortSignal,
        logger,
        url
    })

    const image = await Jimp.read(path)

    await image.quality(20).resize(768, Jimp.AUTO).writeAsync(thumbPath)
}

async function rtspToJpeg({stream, abortSignal, logger, url}: any) {
    await runProcess({
        abortSignal,
        logger,
        command: [
            'ffmpeg',
            '-hide_banner', '-loglevel', 'error',
            '-i', url,
            '-ss', '00:00:01.000',
            '-f', 'image2',
            '-frames:v', '1',
            '-'
        ],
        outputStream: stream
    })
}

runApp<Config>({
    config: {
        userProvidedConfigSchema: tsToJsSchema<Config>()
    },
    services: {
        camera({config}) {
            return new Camera(config.camera)
        },
        api({logger, config, camera, abortSignal}) {

            return new HttpServer({
                logger,
                port: config.port,
                routes: [
                    {
                        path: '/ui',
                        srcPath: __dirname + '/index.html'
                    },
                    {
                        path: '/session',
                        async handler(_, res) {
                            res.send(!!session)
                        }
                    },
                    {
                        path: '/session',
                        method: 'POST',
                        async handler() {
                            if (session) {
                                return
                            }
                            await camera.gotoMainPosition()

                            session = {
                                interval: setInterval(async () => {
                                    snapshot({logger, abortSignal, url: await camera.getRtspUrl()})
                                }, 1000 * 60 * 5),
                                timeout: setTimeout(async () => {
                                    clearInterval(session.interval)
                                    session = undefined
                                    await camera.gotoSecretPosition()
                                }, 1000 * 60 * 60 * 10)
                            }

                            snapshot({logger, abortSignal, url: await camera.getRtspUrl()})
                        }
                    },
                    {
                        path: '/session',
                        method: 'DELETE',
                        async handler() {
                            if (!session) {
                                return
                            }
                            clearImmediate(session.interval)
                            clearTimeout(session.timeout)
                            session = undefined
                            await camera.gotoSecretPosition()
                        }
                    },
                    {
                        path: '/preview',
                        outputContentType: 'image/jpeg',
                        async handler({abortSignal, logger}, res) {
                            await rtspToJpeg({stream: res, abortSignal, logger, url: await camera.getRtspUrl()})
                        }
                    }
                ]
            })
        }
    },
    // @ts-ignore
    async run({abortSignal, api, camera}) {
        camera.gotoSecretPosition()
        abortSignal.addEventListener('abort', () => {
            if (session) {
                clearImmediate(session.interval)
                clearTimeout(session.timeout)
                session = undefined
                camera.gotoSecretPosition()
            }
        })
        api.start(abortSignal)
    }
})
