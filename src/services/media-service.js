const logger = require("../log-manager");
const faults = require("../onvif-fault");

class MediaService {
    constructor(camera) {
        this.camera = camera;
        const tokenSuffix = this.buildTokenSuffix();

        this.profileTokenHq = `profile_hq_${tokenSuffix}`;
        this.profileTokenLq = `profile_lq_${tokenSuffix}`;
        this.videoSourceToken = `video_source_${tokenSuffix}`;
        this.videoSourceConfigTokenHq = `video_source_config_hq_${tokenSuffix}`;
        this.videoSourceConfigTokenLq = `video_source_config_lq_${tokenSuffix}`;
        this.videoEncoderTokenHq = `video_encoder_hq_${tokenSuffix}`;
        this.videoEncoderTokenLq = `video_encoder_lq_${tokenSuffix}`;
        this.profileNameHq = `VirtualProfile_HQ_${tokenSuffix}`;
        this.profileNameLq = `VirtualProfile_LQ_${tokenSuffix}`;
        this.videoSourceConfigNameHq = `VideoSourceConfig_HQ_${tokenSuffix}`;
        this.videoSourceConfigNameLq = `VideoSourceConfig_LQ_${tokenSuffix}`;
        this.videoEncoderConfigNameHq = `VideoEncoderConfig_HQ_${tokenSuffix}`;
        this.videoEncoderConfigNameLq = `VideoEncoderConfig_LQ_${tokenSuffix}`;
    }

    buildTokenSuffix() {
        const raw = this.camera?.identity?.serialNumber
            || this.camera?.mac
            || this.camera?.name
            || "camera";

        const normalized = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        return normalized || "camera";
    }

    requireToken(token) {
        if (token === undefined || token === null || token === "") {
            throw faults.invalidArgs();
        }

        return token;
    }

    getProfileDefinition(kind) {
        if (kind === "lq") {
            return {
                kind: "lq",
                profileToken: this.profileTokenLq,
                profileName: this.profileNameLq,
                videoSourceConfigToken: this.videoSourceConfigTokenLq,
                videoSourceConfigName: this.videoSourceConfigNameLq,
                videoEncoderToken: this.videoEncoderTokenLq,
                videoEncoderConfigName: this.videoEncoderConfigNameLq,
                stream: this.camera.streams.lq,
                streamUri: this.camera.endpoints.rtspUriLq
            };
        }

        return {
            kind: "hq",
            profileToken: this.profileTokenHq,
            profileName: this.profileNameHq,
            videoSourceConfigToken: this.videoSourceConfigTokenHq,
            videoSourceConfigName: this.videoSourceConfigNameHq,
            videoEncoderToken: this.videoEncoderTokenHq,
            videoEncoderConfigName: this.videoEncoderConfigNameHq,
            stream: this.camera.streams.hq,
            streamUri: this.camera.endpoints.rtspUriHq
        };
    }

    getProfileDefinitionByToken(token) {
        this.requireToken(token);

        if (token === this.profileTokenHq) {
            return this.getProfileDefinition("hq");
        }

        if (token === this.profileTokenLq) {
            return this.getProfileDefinition("lq");
        }

        throw faults.noProfile();
    }

    getProfileDefinitionByVideoSourceConfigurationToken(token) {
        this.requireToken(token);

        if (token === this.videoSourceConfigTokenHq) {
            return this.getProfileDefinition("hq");
        }

        if (token === this.videoSourceConfigTokenLq) {
            return this.getProfileDefinition("lq");
        }

        throw faults.noConfig();
    }

    getProfileDefinitionByVideoEncoderConfigurationToken(token) {
        this.requireToken(token);

        if (token === this.videoEncoderTokenHq) {
            return this.getProfileDefinition("hq");
        }

        if (token === this.videoEncoderTokenLq) {
            return this.getProfileDefinition("lq");
        }

        throw faults.noConfig();
    }

    buildProfile(profile) {
        return {
            $attributes: {
                token: profile.profileToken,
                fixed: true
            },
            Name: profile.profileName,
            VideoSourceConfiguration: {
                $attributes: {
                    token: profile.videoSourceConfigToken
                },
                Name: profile.videoSourceConfigName,
                UseCount: 1,
                SourceToken: this.videoSourceToken
            },
            VideoEncoderConfiguration: {
                $attributes: {
                    token: profile.videoEncoderToken
                },
                Name: profile.videoEncoderConfigName,
                UseCount: 1,
                Encoding: profile.stream.encoding,
                Resolution: {
                    Width: profile.stream.width,
                    Height: profile.stream.height
                },
                Quality: profile.stream.quality,
                RateControl: {
                    FrameRateLimit: profile.stream.framerate,
                    EncodingInterval: 1,
                    BitrateLimit: profile.stream.bitrate
                }
            }
        };
    }

    // ONVIF: GetProfiles
    async GetProfiles() {
        const profiles = [
            this.buildProfile(this.getProfileDefinitionByToken(this.profileTokenHq)),
            this.buildProfile(this.getProfileDefinitionByToken(this.profileTokenLq))
        ];

        logger.debug("media", `GetProfiles called for ${this.camera.name} -> ${profiles.map((profile) => profile.$attributes.token).join(", ")}`);

        return {
            Profiles: profiles
        };
    }

    // ONVIF: GetStreamUri
    async GetStreamUri(args) {
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetStreamUri called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind}) -> ${profile.streamUri}`
        );

        return {
            MediaUri: {
                Uri: profile.streamUri,
                InvalidAfterConnect: false,
                InvalidAfterReboot: false,
                Timeout: "PT0S"
            }
        };
    }

    // ONVIF: GetSnapshotUri
    async GetSnapshotUri(args) {
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetSnapshotUri called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind}) -> ${this.camera.endpoints.snapshotUri}`
        );

        return {
            MediaUri: {
                Uri: this.camera.endpoints.snapshotUri,
                InvalidAfterConnect: false,
                InvalidAfterReboot: false,
                Timeout: "PT0S"
            }
        };
    }

    // ONVIF: GetVideoSources
    async GetVideoSources() {
        return {
            VideoSources: [
                {
                    $attributes: {
                        token: this.videoSourceToken
                    },
                    Framerate: this.camera.streams.hq.framerate,
                    Resolution: {
                        Width: this.camera.streams.hq.width,
                        Height: this.camera.streams.hq.height
                    },
                    Bounds: {
                        $attributes: {
                            x: 0,
                            y: 0,
                            width: this.camera.streams.hq.width,
                            height: this.camera.streams.hq.height
                        }
                    }
                }
            ]
        };
    }

    // ONVIF: GetVideoSourceConfiguration
    async GetVideoSourceConfiguration(args) {
        const profile = this.getProfileDefinitionByVideoSourceConfigurationToken(
            args && args.ConfigurationToken
        );

        logger.debug("media",
            `GetVideoSourceConfiguration called for ${this.camera.name} ` +
            `(ConfigurationToken=${args && args.ConfigurationToken}, kind=${profile.kind})`
        );

        return {
            VideoSourceConfiguration: {
                $attributes: {
                    token: profile.videoSourceConfigToken
                },
                Name: profile.videoSourceConfigName,
                UseCount: 1,
                SourceToken: this.videoSourceToken
            }
        };
    }

    // ONVIF: GetVideoEncoderConfiguration
    async GetVideoEncoderConfiguration(args) {
        const profile = this.getProfileDefinitionByVideoEncoderConfigurationToken(
            args && args.ConfigurationToken
        );

        logger.debug("media",
            `GetVideoEncoderConfiguration called for ${this.camera.name} ` +
            `(ConfigurationToken=${args && args.ConfigurationToken}, kind=${profile.kind})`
        );

        return {
            VideoEncoderConfiguration: {
                $attributes: {
                    token: profile.videoEncoderToken
                },
                Name: profile.videoEncoderConfigName,
                UseCount: 1,
                Encoding: profile.stream.encoding,
                Resolution: {
                    Width: profile.stream.width,
                    Height: profile.stream.height
                },
                Quality: profile.stream.quality,
                RateControl: {
                    FrameRateLimit: profile.stream.framerate,
                    EncodingInterval: 1,
                    BitrateLimit: profile.stream.bitrate
                }
            }
        };
    }

    GetServiceDefinition() {
        return {
            GetProfiles: this.GetProfiles.bind(this),
            GetStreamUri: this.GetStreamUri.bind(this),
            GetSnapshotUri: this.GetSnapshotUri.bind(this),
            GetVideoSources: this.GetVideoSources.bind(this),
            GetVideoSourceConfiguration: this.GetVideoSourceConfiguration.bind(this),
            GetVideoEncoderConfiguration: this.GetVideoEncoderConfiguration.bind(this)
        };
    }
}

module.exports = MediaService;
