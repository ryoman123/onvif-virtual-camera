const logger = require("../log-manager");
const { getFixedScopeObjects } = require("../onvif-scopes");

class DeviceService {
    constructor(camera) {
        this.camera = camera;
    }

    buildDeviceCapabilities() {
        return {
            XAddr: this.camera.endpoints.deviceServiceUrl,
            System: {
                DiscoveryResolve: true,
                DiscoveryBye: true,
                SupportedVersions: {
                    Major: 2,
                    Minor: 5
                },
            },
            Security: {
                TLS11: false,
                TLS12: false,
                OnboardKeyGeneration: false,
                AccessPolicyConfig: false,
                X509Token: false,
                SAMLToken: false,
                KerberosToken: false,
                RELToken: false,
                Extension: {
                    TLS10: false,
                    Dot1X: false,
                    RemoteUserHandling: false
                }
            }
        };
    }

    buildMediaCapabilities() {
        return {
            XAddr: this.camera.endpoints.mediaServiceUrl,
            StreamingCapabilities: {
                RTPMulticast: false,
                RTP_TCP: true,
                RTP_RTSP_TCP: true
            },
            Extension: {
                ProfileCapabilities: {
                    MaximumNumberOfProfiles: 2
                }
            }
        };
    }

    buildDeviceServiceCapabilities() {
        return {
            Network: {
                $attributes: {
                    IPFilter: false,
                    ZeroConfiguration: false,
                    IPVersion6: false,
                    DynDNS: false,
                    Dot11Configuration: false,
                    Dot1XConfigurations: 0,
                    HostnameFromDHCP: false,
                    NTP: 0,
                    DHCPv6: false
                }
            },
            Security: {
                $attributes: {
                    "TLS1.0": false,
                    "TLS1.1": false,
                    "TLS1.2": false,
                    OnboardKeyGeneration: false,
                    AccessPolicyConfig: false,
                    DefaultAccessPolicy: false,
                    Dot1X: false,
                    RemoteUserHandling: false,
                    "X.509Token": false,
                    SAMLToken: false,
                    KerberosToken: false,
                    UsernameToken: true,
                    HttpDigest: false,
                    RELToken: false
                }
            },
            System: {
                $attributes: {
                    DiscoveryResolve: true,
                    DiscoveryBye: true,
                    RemoteDiscovery: false,
                    SystemBackup: false,
                    SystemLogging: false,
                    FirmwareUpgrade: false,
                    HttpFirmwareUpgrade: false,
                    HttpSystemBackup: false,
                    HttpSystemLogging: false,
                    HttpSupportInformation: false
                }
            }
        };
    }

    // ONVIF: GetDeviceInformation
    async GetDeviceInformation() {
        logger.debug("device",
            `GetDeviceInformation response for ${this.camera.name}: ` +
            `Manufacturer=${this.camera.identity.manufacturer}, ` +
            `Model=${this.camera.identity.model}, ` +
            `FirmwareVersion=${this.camera.identity.firmwareVersion}, ` +
            `SerialNumber=${this.camera.identity.serialNumber}, ` +
            `HardwareId=${this.camera.identity.hardwareId}`
        );

        return {
            Manufacturer: this.camera.identity.manufacturer,
            Model: this.camera.identity.model,
            FirmwareVersion: this.camera.identity.firmwareVersion,
            SerialNumber: this.camera.identity.serialNumber,
            HardwareId: this.camera.identity.hardwareId
        };
    }

    // ONVIF: GetSystemDateAndTime
    async GetSystemDateAndTime() {
        const now = new Date();

        return {
            SystemDateAndTime: {
                DateTimeType: "NTP",
                DaylightSavings: false,
                TimeZone: {
                    TZ: "UTC"
                },
                UTCDateTime: {
                    Time: {
                        Hour: now.getUTCHours(),
                        Minute: now.getUTCMinutes(),
                        Second: now.getUTCSeconds()
                    },
                    Date: {
                        Year: now.getUTCFullYear(),
                        Month: now.getUTCMonth() + 1,
                        Day: now.getUTCDate()
                    }
                },
                LocalDateTime: {
                    Time: {
                        Hour: now.getHours(),
                        Minute: now.getMinutes(),
                        Second: now.getSeconds()
                    },
                    Date: {
                        Year: now.getFullYear(),
                        Month: now.getMonth() + 1,
                        Day: now.getDate()
                    }
                }
            }
        };
    }

    // ONVIF: GetScopes
    async GetScopes() {
        const scopes = getFixedScopeObjects(this.camera);

        logger.debug("device",
            `GetScopes called for ${this.camera.name} -> ${scopes.map((scope) => scope.ScopeItem).join(", ")}`
        );

        return {
            Scopes: scopes
        };
    }

    // ONVIF: GetDiscoveryMode
    async GetDiscoveryMode() {
        logger.debug("device", `GetDiscoveryMode called for ${this.camera.name} -> Discoverable`);

        return {
            DiscoveryMode: "Discoverable"
        };
    }

    // ONVIF: GetServiceCapabilities
    async GetServiceCapabilities() {
        const capabilities = this.buildDeviceServiceCapabilities();

        logger.debug("device", `GetServiceCapabilities called for ${this.camera.name}`);

        return {
            Capabilities: capabilities
        };
    }

    // ONVIF: GetCapabilities
    async GetCapabilities(args) {
        const category = args && args.Category;
        const requested = Array.isArray(category)
            ? category
            : category
                ? [category]
                : [];

        const allRequested = requested.length === 0 || requested.includes("All");
        const includeDevice = allRequested || requested.includes("Device");
        const includeMedia = allRequested || requested.includes("Media");

        const capabilities = {};

        if (includeDevice) {
            capabilities.Device = this.buildDeviceCapabilities();
        }

        if (includeMedia) {
            capabilities.Media = this.buildMediaCapabilities();
        }

        logger.debug('device', 
            `GetCapabilities called for ${this.camera.name} ` +
            `(Category=${JSON.stringify(category)})`
        );
        logger.debug("device",
            `GetCapabilities response for ${this.camera.name}: ` +
            `includeDevice=${includeDevice}, includeMedia=${includeMedia}, ` +
            `deviceXAddr=${capabilities.Device && capabilities.Device.XAddr}, ` +
            `mediaXAddr=${capabilities.Media && capabilities.Media.XAddr}`
        );

        return {
            Capabilities: capabilities
        };
    }

    // ONVIF: GetServices
    async GetServices(args) {
        const includeCapability = !!(args && args.IncludeCapability);

        const services = [
            {
                Namespace: "http://www.onvif.org/ver10/device/wsdl",
                XAddr: this.camera.endpoints.deviceServiceUrl,
                Version: {
                    Major: 2,
                    Minor: 5
                }
            },
            {
                Namespace: "http://www.onvif.org/ver10/media/wsdl",
                XAddr: this.camera.endpoints.mediaServiceUrl,
                Version: {
                    Major: 2,
                    Minor: 5
                }
            }
        ];

        if (includeCapability) {
            services[0].Capabilities = this.buildDeviceCapabilities();
            services[1].Capabilities = this.buildMediaCapabilities();
        }

        logger.debug('device',`GetServices called for ${this.camera.name} ` + `(IncludeCapability=${includeCapability})`);
        logger.debug("device",
            `GetServices response for ${this.camera.name}: ` +
            services.map((service) =>
                `${service.Namespace} -> ${service.XAddr}`
            ).join(", ")
        );

        return {
            Service: services
        };
    }

    GetServiceDefinition() {
        return {
            GetDeviceInformation: this.GetDeviceInformation.bind(this),
            GetSystemDateAndTime: this.GetSystemDateAndTime.bind(this),
            GetScopes: this.GetScopes.bind(this),
            GetDiscoveryMode: this.GetDiscoveryMode.bind(this),
            GetServiceCapabilities: this.GetServiceCapabilities.bind(this),
            GetCapabilities: this.GetCapabilities.bind(this),
            GetServices: this.GetServices.bind(this)
        };
    }
}

module.exports = DeviceService;