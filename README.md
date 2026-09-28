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
  diagnostics:
    enabled: true
    host: "127.0.0.1"
    port: 9090
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
- `diagnostics.enabled`: Enables the read-only health/status listener. It is enabled by default.
- `diagnostics.host`: Defaults to `127.0.0.1`, keeping the unauthenticated diagnostics listener local to the bridge host/container network namespace.
- `diagnostics.port`: Defaults to `9090`.
- `ws_security.mode`: `audit` preserves compatible authentication while logging freshness/replay findings; `enforce` rejects UsernameTokens that violate the configured replay policy.
- `ws_security.max_age_seconds`: Maximum age of a UsernameToken `Created` timestamp.
- `ws_security.future_skew_seconds`: Allowed client clock lead before a `Created` timestamp is considered invalid.
- `ws_security.nonce_cache_size`: Maximum number of recently accepted nonces retained per virtual camera.
- `ws_security.allow_password_text`: Keeps PasswordText compatibility available. Disable only after confirming every client uses PasswordDigest.

The default is deliberately `audit`: valid credentials continue to work while missing/stale timestamps and nonce replays are surfaced. Switch to `enforce` only after verifying the ONVIF client behavior you actually use.

### Runtime Health and Diagnostics

The bridge exposes two read-only diagnostics endpoints on `127.0.0.1:9090` by default:

```bash
curl -s http://127.0.0.1:9090/healthz
curl -s http://127.0.0.1:9090/status
```

- `/healthz` is a compact readiness probe. It returns HTTP `200` when all virtual cameras are ready and every enabled analytics runtime is connected, or HTTP `503` when the bridge is degraded.
- `/status` returns the detailed runtime snapshot: per-camera lifecycle state, interface/IP, RTSP session counts, PullPoint queue/subscription counters, Frigate MQTT health, and native recorder health.
- Diagnostics deliberately omit source RTSP URLs and credentials.
- The production Docker image uses `/healthz` for its native `HEALTHCHECK`, so `docker ps` reports the container's readiness automatically.
- If diagnostics are explicitly disabled, the Docker healthcheck treats that as intentional and exits successfully.

Binding diagnostics to a non-loopback address makes the unauthenticated status endpoint reachable from other hosts. Keep the default loopback bind unless external monitoring specifically requires otherwise and the network path is appropriately restricted.

### Field Acceptance and Soak Test

The acceptance checker turns the detailed status endpoint into a repeatable deployment gate. It verifies the exact camera count, unique identities, every lifecycle stage, live IP/interface bindings, analytics-target coverage, and connected enabled analytics runtimes. It can also pin the Protect-facing camera identities and require evidence of real analytics delivery and reconnect recovery.

For the 29-camera deployment with Frigate and both recorders:

```bash
npm run acceptance:check -- \
  --expected-cameras 29 \
  --require-frigate \
  --require-recorder lorex \
  --require-recorder nvr69 \
  --identity-manifest ./camera-identities.json
```

The identity manifest is deliberately separate from `config.yml`, contains no credentials, and should be captured from the last trusted deployment. It prevents a same-count replacement from silently changing the MAC-derived WS-Discovery identity or ONVIF serial/hardware identity Protect adopted:

```json
{
  "cameras": [
    {
      "name": "Lorex 1",
      "mac": "02:00:00:00:00:01",
      "serialNumber": "020000000001",
      "hardwareId": "VirtualCam-020000000001"
    }
  ]
}
```

Run the same assertions continuously for a soak period:

```bash
npm run acceptance:check -- \
  --expected-cameras 29 \
  --require-frigate \
  --require-recorder lorex \
  --require-recorder nvr69 \
  --identity-manifest ./camera-identities.json \
  --min-frigate-events 1 \
  --min-recorder-events lorex=1 \
  --min-recorder-events nvr69=1 \
  --min-recorder-connections lorex=2 \
  --min-recorder-connections nvr69=2 \
  --soak-seconds 43200 \
  --interval-seconds 30
```

The event minimums prove that each configured path dispatched a real event since process start. A connection minimum of `2` proves the recorder client established a second connection after a controlled interruption. Start the soak only after generating representative Frigate and recorder detections and completing the interruption/recovery exercise; the counters are cumulative for the current bridge process.

The command prints a machine-readable JSON result and exits non-zero on the first failed sample. Run it inside the host-networked bridge container when diagnostics uses its default loopback binding. A successful code/CI result does not replace this live acceptance gate: production acceptance additionally requires 29/29 healthy cameras, confirmation in the real Protect UI, and a completed soak.

### Frigate Analytics Events

Frigate detections can be translated into ONVIF PullPoint events and delivered through the same virtual camera that Protect has adopted. The bridge includes its own MQTT 3.1.1 client, so no extra MQTT package or sidecar is required.

```yaml
analytics:
  frigate:
    enabled: true
    broker: "mqtt://192.168.1.20:1883"
    topic_prefix: "frigate"
    client_id: "onvif-vcam"
    reconnect_period_ms: 5000
    connect_timeout_ms: 30000
    keepalive_seconds: 30
    camera_map: auto
    # username: "mqtt-user"
    # password: "mqtt-password"
```

- `broker`: MQTT broker URL using `mqtt://` or `mqtts://`. Put credentials in the dedicated fields rather than embedding them in the URL.
- `camera_map`: Maps Frigate camera names to configured virtual camera names. Set it to `auto` to derive stable lowercase/underscore names from every virtual camera, or provide an explicit mapping object. Unknown targets and automatic naming collisions are rejected during startup.
- `topic_prefix`: Defaults to `frigate` and subscribes to availability, tracked-object events, and per-camera motion topics.
- `client_id`: MQTT client identity. Use a unique value if multiple bridge instances share one broker.
- `reconnect_period_ms`: Delay before reconnecting after a broker disconnect. Set to `0` to disable automatic reconnect.
- `connect_timeout_ms`: Connection timeout for the MQTT broker.
- `keepalive_seconds`: MQTT keepalive interval. Set to `0` to disable MQTT keepalive pings.

Person, vehicle, animal, package, and motion state is normalized before publication. Overlapping detections are aggregated so one source cannot clear an ONVIF state while another contributor remains active.

### UniFi Protect third-party camera behavior

Protect treats ONVIF cameras as third-party devices. The ONVIF event path can provide standard motion events through PullPoint, using the widely recognized `tns1:RuleEngine/CellMotionDetector/Motion` topic. Frigate person/vehicle events are also exposed as standard ONVIF analytics topics.

Protect does **not** generally expose native smart-detection/person/vehicle recording features for third-party ONVIF cameras by itself. Those features normally require a UniFi AI Port or native Protect camera. This project therefore targets reliable motion/event interoperability while keeping Frigate inference external and recording in Protect.

### Frigate AI Sidecar Deployment

The repository can generate a Frigate deployment directly from the bridge camera inventory. The generated deployment is intentionally an **AI sidecar**: it uses each virtual camera's configured LQ source for object detection, publishes detections over MQTT, and leaves recording to UniFi Protect.

```bash
npm run frigate:generate -- \
  --input ./config.yml \
  --output-dir ./frigate-sidecar
```

The output contains:

- `config/config.yml`: Frigate configuration with one detect-only camera for every virtual camera.
- `.env`: MQTT and RTSP credentials, written separately from the Frigate YAML with file mode `0600`.
- `docker-compose.yml`: A deployable Frigate `stable` container using the authenticated UI on port `8971` and WebRTC on `8555`. The unauthenticated API port `5000` and host RTSP port `8554` are deliberately not published.
- `bridge-frigate-map.yml`: The exact generated Frigate-to-virtual-camera mapping for auditing or explicit configuration.

The generator creates deterministic Frigate camera names from the bridge names and caps detection at 5 FPS by default. It reuses the LQ stream resolution when one is declared in `stream_lq`, and routes Frigate's ffmpeg process through its internal go2rtc restream so the AI pipeline maintains one source connection per detect stream.

To change the detection ceiling:

```bash
npm run frigate:generate -- --input ./config.yml --detect-fps 7 --force
```

For `mqtts://` brokers, the generator enables MQTT TLS and defaults to the container's system CA bundle. A custom CA path inside the Frigate container can be supplied with `--mqtt-ca-certs`.

The sidecar does not hard-code an object detector backend or video hardware-acceleration preset because those depend on the host hardware. Configure the available accelerator in Frigate after the generated deployment is running. The generated object list matches the bridge's built-in event adapter: person, common vehicles, dog, cat, and bird.

### Native Dahua/Lorex Recorder Events

Dahua-compatible recorders, including many Lorex NVRs, can feed their native motion and smart-motion events directly into the same ONVIF PullPoint pipeline. The bridge maintains the recorder event stream itself, handles HTTP Digest authentication, and reconnects automatically.

```yaml
analytics:
  recorders:
    - name: "lorex"
      enabled: true
      host_source: cam1
      source: "lorex"
      protocol: "http"
      path: "/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5"
      reconnect_period_ms: 5000
      connect_timeout_ms: 10000
      inactivity_timeout_ms: 20000
      tls_reject_unauthorized: true
      channel_map:
        "0": "VirtualCam1"
        "1": "VirtualCam2"
```

- `host_source`: Reuses the recorder address, HTTP port, and credentials already defined under `host_sources`; recorder passwords do not need to be duplicated.
- `channel_map`: Maps the recorder's event `index` to a virtual camera. Dahua/Lorex event indices are zero-based, so recorder index `0` normally corresponds to the first channel.
- `path`: Defaults to the event-manager attach endpoint with `codes=[All]` and a 5-second heartbeat.
- `protocol`: Uses `http` by default and may be set to `https`.
- `inactivity_timeout_ms`: Reconnects if the long-lived stream stops delivering data. The 20-second default allows several missed 5-second heartbeats before recovery.
- `tls_reject_unauthorized`: Defaults to `true`. Set it to `false` only when a local HTTPS recorder uses a certificate that the container cannot validate.

The native parser currently translates `VideoMotion`, `SmartMotionHuman`, and `SmartMotionVehicle` into ONVIF motion, person, and vehicle property events. Native recorder events and Frigate detections may be enabled together; the dispatcher aggregates overlapping contributors before changing the ONVIF state.

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
