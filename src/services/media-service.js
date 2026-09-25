const logger = require("../log-manager");
const faults = require("../onvif-fault");
const { buildMediaServiceCapabilities } = require("../service-capabilities");

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

    validateStreamSetup(streamSetup) {
        if (!streamSetup) {
            throw faults.invalidArgs();
        }

        const streamType = streamSetup.Stream;
        const protocol = streamSetup.Transport && streamSetup.Transport.Protocol;

        if (!streamType || !protocol) {
            throw faults.invalidStreamSetup();
        }

        if (streamType !== "RTP-Unicast" || !["RTSP", "TCP"].includes(protocol)) {
            throw faults.invalidStreamSetup();
        }

        return {
            streamType,
            protocol
        };
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

    buildVideoSourceConfiguration(profile) {
        return {
            $attributes: {
                token: profile.videoSourceConfigToken
            },
            Name: profile.videoSourceConfigName,
            UseCount: 1,
            SourceToken: this.videoSourceToken
        };
    }

    buildVideoEncoderConfiguration(profile) {
        return {
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
        };
    }

    buildProfile(profile) {
        return {
            $attributes: {
                token: profile.profileToken,
                fixed: true
            },
            Name: profile.profileName,
            VideoSourceConfiguration: this.buildVideoSourceConfiguration(profile),
            VideoEncoderConfiguration: this.buildVideoEncoderConfiguration(profile)
        };
    }

    buildVideoEncoderConfigurationOptions(profile) {
        const streams = profile
            ? [profile.stream]
            : [this.camera.streams.hq, this.camera.streams.lq];

        const qualityValues = streams
            .map((stream) => Number(stream.quality))
            .filter((value) => Number.isFinite(value));

        const minimumQuality = qualityValues.length > 0 ? Math.min(...qualityValues) : 0;
        const maximumQuality = qualityValues.length > 0 ? Math.max(...qualityValues) : 0;

        return {
            QualityRange: {
                Min: minimumQuality,
                Max: maximumQuality
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

    // ONVIF: GetProfile
    async GetProfile(args) {
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetProfile called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind})`
        );

        return {
            Profile: this.buildProfile(profile)
        };
    }
    // ONVIF: GetStreamUri
    async GetStreamUri(args) {
        const setup = this.validateStreamSetup(args && args.StreamSetup);
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetStreamUri called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind}, ` +
            `Stream=${setup.streamType}, Protocol=${setup.protocol}) -> ${profile.streamUri}`
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

    // ONVIF: GetVideoSourceConfigurations
    async GetVideoSourceConfigurations() {
        const configurations = [
            this.buildVideoSourceConfiguration(this.getProfileDefinition("hq")),
            this.buildVideoSourceConfiguration(this.getProfileDefinition("lq"))
        ];

        logger.debug("media", `GetVideoSourceConfigurations called for ${this.camera.name}`);

        return {
            Configurations: configurations
        };
    }

    // ONVIF: GetCompatibleVideoSourceConfigurations
    async GetCompatibleVideoSourceConfigurations(args) {
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetCompatibleVideoSourceConfigurations called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind})`
        );

        return {
            Configurations: [
                this.buildVideoSourceConfiguration(profile)
            ]
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

    // ONVIF: GetVideoEncoderConfigurations
    async GetVideoEncoderConfigurations() {
        const configurations = [
            this.buildVideoEncoderConfiguration(this.getProfileDefinition("hq")),
            this.buildVideoEncoderConfiguration(this.getProfileDefinition("lq"))
        ];

        logger.debug("media", `GetVideoEncoderConfigurations called for ${this.camera.name}`);

        return {
            Configurations: configurations
        };
    }

    // ONVIF: GetCompatibleVideoEncoderConfigurations
    async GetCompatibleVideoEncoderConfigurations(args) {
        const profile = this.getProfileDefinitionByToken(args && args.ProfileToken);

        logger.debug("media",
            `GetCompatibleVideoEncoderConfigurations called for ${this.camera.name} ` +
            `(ProfileToken=${args && args.ProfileToken}, kind=${profile.kind})`
        );

        return {
            Configurations: [
                this.buildVideoEncoderConfiguration(profile)
            ]
        };
    }

    // ONVIF: GetVideoEncoderConfigurationOptions
    async GetVideoEncoderConfigurationOptions(args) {
        let configurationProfile = null;
        let mediaProfile = null;

        if (args && args.ConfigurationToken !== undefined && args.ConfigurationToken !== null && args.ConfigurationToken !== "") {
            configurationProfile = this.getProfileDefinitionByVideoEncoderConfigurationToken(
                args.ConfigurationToken
            );
        }

        if (args && args.ProfileToken !== undefined && args.ProfileToken !== null && args.ProfileToken !== "") {
            mediaProfile = this.getProfileDefinitionByToken(args.ProfileToken);
        }

        if (configurationProfile && mediaProfile && configurationProfile.kind !== mediaProfile.kind) {
            throw faults.invalidArgs();
        }

        const profile = configurationProfile || mediaProfile;

        logger.debug("media",
            `GetVideoEncoderConfigurationOptions called for ${this.camera.name} ` +
            `(ConfigurationToken=${args && args.ConfigurationToken}, ProfileToken=${args && args.ProfileToken}, ` +
            `kind=${profile ? profile.kind : "generic"})`
        );

        return {
            Options: this.buildVideoEncoderConfigurationOptions(profile)
        };
    }
    // ONVIF: GetServiceCapabilities
    async GetServiceCapabilities() {
        const capabilities = buildMediaServiceCapabilities();

        logger.debug("media", `GetServiceCapabilities called for ${this.camera.name}`);

        return {
            Capabilities: capabilities
        };
    }

    GetServiceDefinition() {
        return {
            GetServiceCapabilities: this.GetServiceCapabilities.bind(this),
            GetProfiles: this.GetProfiles.bind(this),
            GetProfile: this.GetProfile.bind(this),
            GetStreamUri: this.GetStreamUri.bind(this),
            GetSnapshotUri: this.GetSnapshotUri.bind(this),
            GetVideoSources: this.GetVideoSources.bind(this),
            GetVideoSourceConfiguration: this.GetVideoSourceConfiguration.bind(this),
            GetVideoSourceConfigurations: this.GetVideoSourceConfigurations.bind(this),
            GetCompatibleVideoSourceConfigurations: this.GetCompatibleVideoSourceConfigurations.bind(this),
            GetVideoEncoderConfiguration: this.GetVideoEncoderConfiguration.bind(this),
            GetVideoEncoderConfigurations: this.GetVideoEncoderConfigurations.bind(this),
            GetCompatibleVideoEncoderConfigurations: this.GetCompatibleVideoEncoderConfigurations.bind(this),
            GetVideoEncoderConfigurationOptions: this.GetVideoEncoderConfigurationOptions.bind(this)
        };
    }
}

module.exports = MediaService;
