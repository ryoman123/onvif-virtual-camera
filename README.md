# ONVIF Virtual Camera Server

This project creates virtual ONVIF cameras for UniFi Protect. It is intended for sources that Protect cannot adopt cleanly on its own, including cameras without useful ONVIF support and multi-head cameras that need to appear as separate devices. It is an independent fork of the original [`onvif-server`](https://github.com/daniela-hase/onvif-server) project by Daniela Hasenbring.

Each virtual camera gets its own:

- MAC address
- IP address
- ONVIF Device and Media Services
- RTSP HQ and LQ endpoints
- Snapshot endpoint

The project is designed to run in Docker with host networking. Each virtual camera is bound to its own MacVLAN interface so UniFi Protect can adopt it as an individual device.

## Getting Started

1. Create a `config.yml` for your host sources and virtual cameras.
2. Create the required MacVLAN interfaces on the Docker host.
3. Start the container with host networking and mount the config as `/config.yml`.
4. Check the container logs to confirm each virtual camera started successfully.
5. Add the virtual camera IPs in UniFi Protect.

## Configuration

This project uses a YAML config file, usually named `config.yml`, placed alongside your Docker deployment files. Ensure it is mounted into the container as shown in the Docker Usage section below.

Use [resources/config-example.yml](./resources/config-example.yml) as the starting point for your file.

### Runtime Settings

```yaml
runtime:
  enable_debug_logs: false
  probe_streams: true
  probe_timeout_ms: 15000
  ip_monitor_interval_ms: 5000
  ws_security:
    mode: audit
    max_age_seconds: 300
    future_skew_seconds: 300
    nonce_cache_size: 2048
    allow_password_text: true
```

- `enable_debug_logs`: Uses `false`, `true`, or an array of debug categories (auth, config, device, discovery, http, lifecycle, media, network, snapshot).
- `probe_streams`: Probe source streams with `ffprobe` when a camera does not define `stream_hq` and `stream_lq` blocks.
- `probe_timeout_ms`: Timeout for RTSP stream probing.
- `ip_monitor_interval_ms`: Interval used to check for IP address changes due to DHCP.
- `ws_security.mode`: `audit` preserves compatible authentication while logging freshness/replay findings; `enforce` rejects UsernameTokens that violate the configured replay policy.
- `ws_security.max_age_seconds`: Maximum age of a UsernameToken `Created` timestamp.
- `ws_security.future_skew_seconds`: Allowed client clock lead before a `Created` timestamp is considered invalid.
- `ws_security.nonce_cache_size`: Maximum number of recently accepted nonces retained per virtual camera.
- `ws_security.allow_password_text`: Keeps PasswordText compatibility available. Disable only after confirming every client uses PasswordDigest.

The default is deliberately `audit`: valid credentials continue to work while missing/stale timestamps and nonce replays are surfaced. Switch to `enforce` only after verifying the ONVIF client behavior you actually use.

### Host Sources

Each host source element describes the `real` camera or recorder endpoint:

```yaml
host_sources:
  - name: cam1
    hostname: 192.168.1.50
    rtsp_port: 554
    http_port: 80
    auth:
      username: "admin"
      password: "password123"
```

- `name`: Used for later reference and should be short while avoiding special characters/spaces.
- `hostname`: The IP address or DNS hostname of the actual video source.
- `rtsp_port`: Port on the host for RTSP streams.
- `http_port`: Port on the host for HTTP requests.
- `auth`: The username and password to be used for authentication at the host. May be omitted if not required.

### Virtual Cameras

Each virtual camera element describes details and configuration for your `virtual` camera and should have these minimally required fields:

```yaml
name: "VirtualCam1"
manufacturer: "Acme"
model: "VCam-1080p"
mac: "02:42:ac:11:00:11"
ip: "192.168.1.210/24"
host_source: cam1
rtsp_path_hq: "/live1"
rtsp_path_lq: "/live1-sub"
snapshot_path: "/snapshot1.jpg"
```

- `name`: Used for internal reference and logging.
- `manufacturer`: Used along with `model` by Protect to construct labeling for this virtual camera.
- `model`: Used along with `manufacturer` by Protect to construct labeling for this virtual camera.
- `mac`: A unique MAC address for network services and that Protect will use for identity.
- `ip`: Either the string `DHCP` or an IP address (in CIDR format) to use for network services.
- `host_source`: Pointer to the parent `host` for this virtual camera.
- `rtsp_path_hq`: Path to be used for the high-quality RTSP stream.
- `rtsp_path_lq`: Path to be used for the low-quality RTSP stream.
- `snapshot_path`: Path to be used for fetching the still image snapshot.

With optional identity fields:

```yaml
firmware_version: "12.4V3"
serial_number: "1234ABCD"
hardware_id: "00012-34567"
```

- `firmware_version`: Available additional identity metadata.
- `serial_number`: Available additional identity metadata.
- `hardware_id`: Available additional identity metadata.

And optional manual stream settings:

```yaml
stream_hq:
  encoding: "H264"
  width: 1920
  height: 1080
  framerate: 15
  bitrate: 2048
  quality: 5
stream_lq:
  encoding: "H264"
  width: 640
  height: 360
  framerate: 10
  bitrate: 512
  quality: 3
```

- `stream_hq`: Must be complete if provided. If omitted, probing is used for the HQ stream (if `probe_streams` also enabled).
- `stream_lq`: Must be complete if provided. If omitted, it is derived using the same process as `stream_hq`.
- `encoding`: Video codec to use. Supported values map cleanly to H264, H265, and MJPEG.
- `width`: Frame width in pixels.
- `height`: Frame height in pixels.
- `framerate`: Frames per second. Must be a positive integer.
- `bitrate`: Target bitrate in kbps. Must be a positive integer.
- `quality`: Encoder quality value. Must be a positive number.


## MacVLAN Setup

Each virtual camera must appear as a separate device on the network with its own unique MAC and IP address for successful adoption by UniFi Protect (v7.0.94). A MacVLAN helper script is included in the Docker image to simplify this setup, but it must be copied to the host before use.

The helper script:

- creates `vcam-<index>` interfaces
- applies the configured MAC addresses
- assigns DHCP or static IPs based on your config file
- can clean up generated interfaces and persistence files

> [!CAUTION]
> The script must be run on the host, not inside the container.

> [!WARNING]
> MacVLANs are required for this project and they must be configured to match your config.yml exactly. Using the helper script is highly recommended.

### Using the helper script for setup

Start or create the container first, then copy the helper script to the host (if your container name differs, adjust "onvif-vcam-server" in the command below accordingly).

```bash
sudo docker cp onvif-vcam-server:/app/resources/macvlan-init.sh ./macvlan-init.sh
sudo chmod +x ./macvlan-init.sh
```

Example run mode:

```bash
sudo ./macvlan-init.sh --config "./config.yml" --parent eth0
```

Example cleanup mode:

```bash
sudo ./macvlan-init.sh --cleanup
```

## Docker Usage

Example Docker Compose configuration:

```yaml
services:
  onvif-vcam-server:
    image: ghcr.io/emberstonel/onvif-virtual-camera
    container_name: onvif-vcam-server
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./config.yml:/config.yml:ro
```

> [!NOTE]
> `network_mode: host` is required because the container needs direct access to the host MacVLAN interfaces.

## Running

Start the container:

```bash
sudo docker compose up -d
```

View logs:

```bash
sudo docker logs -f onvif-vcam-server
```

On a successful startup, expect to see:

- configuration loaded
- one initialization attempt per virtual camera
- one short success line per virtual camera showing MAC, interface, and IP
- a final initialization complete line

If startup fails, the logs should point to the relevant stage, such as config validation, interface lookup, bind failure, or source probing.

## Adding Cameras to UniFi Protect

1. Open UniFi Protect and navigate to Devices.
2. Your virtual cameras should appear for adoption in the list; click the "Adopt" link.
3. Enter the source credentials if the camera requires authentication.
4. Repeat for each virtual camera identity you configured.
