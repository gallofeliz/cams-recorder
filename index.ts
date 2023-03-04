import { runApp } from '@gallofeliz/application'
import { HttpServer } from '@gallofeliz/http-server'
import { runProcess } from '@gallofeliz/run-process'
import { tsToJsSchema } from '@gallofeliz/typescript-transform-to-json-schema'

interface Config {
    uri: string
    /** @default 80 */
    port: number
}

runApp<Config>({
    config: {
        userProvidedConfigSchema: tsToJsSchema<Config>()
    },
    services: {
        api({logger, config}) {
            return new HttpServer({
                logger,
                port: config.port,
                api: {
                    routes: [{
                        path: '/proxy',
                        outputContentType: 'image/jpeg',
                        async handler({abortSignal, logger}, res) {
                            await runProcess({
                                abortSignal,
                                logger,
                                command: [
                                    'ffmpeg',
                                    '-hide_banner', '-loglevel', 'error',
                                    '-i', config.uri,
                                    '-ss', '00:00:01.000',
                                    '-f', 'image2',
                                    '-frames:v', '1',
                                    '-'
                                ],
                                outputStream: res
                            })
                        }
                    }]
                }
            })
        }
    },
    run({abortSignal, api}) {
        api.start(abortSignal)
    }
})
