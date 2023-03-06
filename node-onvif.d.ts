declare module 'node-onvif' {

    interface Info {

    }

    interface Profile {
        token: string
        snapshot: string
        stream: {
            rtsp: string
        }
    }

    interface GotoPreset {
      ProfileToken: string
      PresetToken : string
      Speed       : {'x': number, 'y': number, 'z': number}

    }

    class OnvifDevice {
        constructor(params: {xaddr: string, user: string, pass: string})
        init(): Promise<Info>
        getCurrentProfile(): Promise<Profile>
        services: {
            ptz: {
                gotoPreset(params: GotoPreset): Promise<void>
            }
        }
    }
}
