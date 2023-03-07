import { runApp } from '@gallofeliz/application'
import { HttpServer } from '@gallofeliz/http-server'
import { runProcess } from '@gallofeliz/run-process'
import { tsToJsSchema } from '@gallofeliz/typescript-transform-to-json-schema'
// @ts-ignore
import { OnvifDevice } from 'node-onvif'
import { setTimeout as wait } from 'timers/promises'
import { createWriteStream } from 'fs'
import { mkdir, unlink, readdir, rmdir } from 'fs/promises'
import dayjs from 'dayjs'
import { dirname, basename } from 'path'
import Jimp from 'jimp'
import { globIterate, glob } from 'glob'
import ms from 'ms'

interface Config {
    camera: {
        onvifUrl: string
        user: string
        pass: string
        /** @default 3 */
        ptzMainPreset: string
        /** @default 2 */
        ptzSecretPreset: string
    }
    /** @default 5 minutes */
    snapshotInterval: string
    /** @default 10 hours */
    sessionMaxDuration: string
    /** @default 1 day */
    pruneInterval: string
    /** @default 2 weeks */
    pruneMaxAge: string
    //uri: string
    /** @default 80 */
    port: number
}

class Camera {
    protected onvifDevice: OnvifDevice
    protected user: string
    protected pass: string
    protected ptzMainPreset: string
    protected ptzSecretPreset: string

    constructor({onvifUrl, user, pass, ptzMainPreset, ptzSecretPreset}: any) {
        this.user = user
        this.pass = pass
        this.onvifDevice = new OnvifDevice({
          xaddr: onvifUrl,
          user,
          pass
        })
        this.ptzMainPreset = ptzMainPreset
        this.ptzSecretPreset = ptzSecretPreset
    }

    protected async init() {
        await this.onvifDevice.init()
    }

    async getRtspUrl() {
        const profile = await this.onvifDevice.getCurrentProfile()
        return profile.stream.rtsp.replace(
            'rtsp://',
            'rtsp://'+encodeURIComponent(this.user)+':'+encodeURIComponent(this.pass)+'@'
        )
    }

    async gotoMainPosition() {
        await this.init()

        await this.onvifDevice.services.ptz.gotoPreset({
            ProfileToken: (await this.onvifDevice.getCurrentProfile()).token,
            PresetToken: this.ptzMainPreset,
            Speed: { x: 0.5, y: 0.5, z: 0.5 }
        })
        await wait(8000)
    }

    async gotoSecretPosition() {
        await this.init()

        await this.onvifDevice.services.ptz.gotoPreset({
            ProfileToken: (await this.onvifDevice.getCurrentProfile()).token,
            PresetToken: this.ptzSecretPreset,
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

async function prune(maxAge: number) {
    const pruneBefore = dayjs().subtract(maxAge, 'milliseconds').format('YYYY-MM-DDTHH:mm:ss')
    for await (const file of globIterate('/data/cam1/**/*.jpg', {nodir: true, signal: undefined}))  {
        const date = basename(file).replace('.jpg', '')
        if (date < pruneBefore) {
            await unlink(file)
        }
    }

    for (const dir of (await glob('/data/cam1/*/**/', {signal: undefined})).sort().reverse())  {
        if ((await readdir(dir)).length === 0) {
            await rmdir(dir)
        }
    }
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
                        path: '/',
                        srcPath: __dirname + '/index.html'
                    },
                    {
                        path: '/static',
                        srcPath: __dirname + '/node_modules'
                    },
                    {
                        path: '/session',
                        async handler(_, res) {
                            res.send(!!session)
                        }
                    },
                    {
                        path: '/cameras',
                        async handler(_, {send}) {
                            const dirs = await glob(`*/`, {cwd: '/data'})

                            send(dirs.map(dir => dir.replace('/', '')))
                        }
                    },
                    {
                        path: '/images',
                        async handler({query}, {send}) {
                            const from = dayjs(query.start)
                            const to = dayjs(query.end);
                            const nbDays = to.diff(from, 'hours') + 1;
                            const dirsSearch: any[] = []
                            const filesSearch = (new Array(nbDays)).fill(undefined).map((_, i) =>  {
                                const d = from.clone().add(i, 'hours');
                                const day = d.format('YYYY-MM-DD');
                                if (!dirsSearch.includes(day)) {
                                    dirsSearch.push(day)
                                }
                                return d.format('YYYY-MM-DDTHH')
                            }
                            );

                            const globP = `@(${dirsSearch.join('|')})/@(${filesSearch.join('|')})*.jpg`
                            const files = await glob(globP, {cwd: `/data/${query.camera}`});

                            send(files.map(file => file.split('/')[1].split('.')[0]).sort())
                        }
                    },
                    {
                        path: '/images/:camera/:datetime.jpg',
                        outputContentType: 'image/jpeg',
                        async handler({params, query}, {sendFile}) {
                            const parts = [
                                '/data',
                                params.camera,
                                params.datetime.split('T')[0],
                                query.thumb ? 'thumbs' : null,
                                params.datetime
                            ].filter(part => part)

                            sendFile(parts.join('/') + '.jpg', {root: '/'})
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
                                }, ms(config.snapshotInterval)),
                                timeout: setTimeout(async () => {
                                    clearInterval(session.interval)
                                    session = undefined
                                    await camera.gotoSecretPosition()
                                }, ms(config.sessionMaxDuration))
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
    async run({abortSignal, api, camera, config}) {
        camera.gotoSecretPosition()

        const pruneInterval = setInterval(() => {
            prune(ms(config.pruneMaxAge))
        }, ms(config.pruneInterval))

        prune(ms(config.pruneMaxAge))

        abortSignal.addEventListener('abort', () => {
            clearInterval(pruneInterval)
            if (session) {
                clearInterval(session.interval)
                clearTimeout(session.timeout)
                session = undefined
                camera.gotoSecretPosition()
            }
        })
        api.start(abortSignal)
    }
})
