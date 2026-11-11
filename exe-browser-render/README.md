# Arcade Hub 3.2 — Public Render server-side build

This version removes the shared access-key prompt. It moves the Windows compatibility runtime off the visitor's Chromebook, Quest 3S, phone, or PC. The uploaded game is staged and launched by Wine inside the Render Docker service. A virtual X11 desktop is exposed to browsers through x11vnc + websockify + noVNC.

**This is a server-side Linux compatibility environment, not a full Windows VM.** Wine runs Windows programs that it supports; DOSBox handles classic DOS games; ScummVM runs only games supported by its own engines. It does not guarantee compatibility with every `.exe`.

## What changed from v3.1

- The old Boxedwine/WebAssembly player has been removed from the launch path. The game process now runs on the Render server.
- Browsers connect to the shared remote desktop through noVNC/WebSockets. The client device handles screen display, video/frame drawing, and input events, not x86/Windows game emulation.
- The upload API accepts any file extension. It supports multi-file and folder uploads, with each selection grouped as one game.
- ZIP archives are extracted on the server with checks for path traversal, symbolic links, entry-count limits, and expanded-size limits.
- A game group can contain an `.exe`, `.msi`, ZIP, DLLs, data files, and other assets. The server stages the group in a working folder and runs the first suitable executable found.
- Three server-installed runtimes are available: Wine (Windows Win32/Win64), DOSBox (classic DOS titles), and ScummVM (supported classic adventure games).
- Wine's built-in Notepad, a DOSBox prompt, and the ScummVM launcher are included as runtime smoke tests.
- The previous shared-key login has been removed. All app features are publicly available to anyone with the URL. Recently played history is remembered per browser in a small cookie.
- The desktop is shared: all connected users see and control the same current game. Launching another title replaces the current title for everyone.

## Render Free limitations — read before deploying

Render's current Free web-service plan provides **0.1 CPU and 512 MB RAM**. This build can be deployed on Free, but those resources are extremely limited for a server-side Windows compatibility layer. Treat Free as a smoke-test for Notepad and very lightweight older 2D titles. The app may be slow, hit memory limits, or fail to start larger games. There is no physical GPU; the virtual desktop uses software graphics. Demanding 3D games and modern DirectX titles are not realistic targets on this plan.

Render Free services also spin down after 15 minutes without inbound HTTP requests or WebSocket messages. The service takes about a minute to wake up again. Its local filesystem is ephemeral, so uploaded files, the active game, and the Wine session are lost when the service spins down, restarts, or redeploys. Browser cookies preserve only per-browser recent-game metadata—not the actual games.

This version solves the *device-side emulation* problem, but it cannot add CPU, RAM, or GPU resources to Render Free. It is not cloud gaming at a gaming-PC performance level.

## Deploy to Render

This project now uses Docker because it needs Linux packages such as Wine, DOSBox, ScummVM, Xvfb, x11vnc, noVNC, and websockify.

### Updating the existing Render service

This package uses **Docker** so Render can install Wine, DOSBox, ScummVM, and the virtual desktop packages. If you are updating an existing v3.1 service, it should already be set to Docker; keep that runtime and replace the repository files.

1. Extract this ZIP.
2. Copy the **contents** of the `exe-browser-render` folder into the root of the GitHub repository connected to your Render service. The repository root should contain `Dockerfile`, `render.yaml`, `server.mjs`, and the `public/` folder. Commit and push the changes.
3. In the existing Render service, open **Settings → Build → Source → Edit**. Keep the same repository and branch, but change the runtime/language to **Docker**, then save.
4. Set the Root Directory to blank when `Dockerfile` is at the repository root. If you kept the enclosing folder inside the repository, set Root Directory to `exe-browser-render`.
5. Leave Build Command and Start Command blank. Render builds the Dockerfile and uses its `ENTRYPOINT` automatically.
6. No access-key environment variable is required. If `LIBRARY_KEY` remains in your Render environment settings from v3.1, it is now unused and can be removed.
7. Trigger a deploy and check the Docker build log and `/api/health` after it starts.

Render documents changing a service's runtime through the source settings and building services from a Dockerfile. If you would rather keep the old Node service untouched, create a separate new Docker Web Service from the same repository instead; the included `render.yaml` declares a Free plan.

### Dashboard settings

| Render field | Value |
|---|---|
| Language / Runtime | **Docker** |
| Root Directory | Blank if repo root contains `Dockerfile`; otherwise `exe-browser-render` |
| Build Command | **Leave blank** (Dockerfile build) |
| Start Command | **Leave blank** (Dockerfile ENTRYPOINT) |
| Dockerfile Path | `./Dockerfile` (if repo root is the app folder) |
| Docker Context | `.` |
| Plan | Free (very limited performance) |

If you reuse an existing Render service, check that the service runtime is changed to Docker and that the Dockerfile is in the correct root directory. To avoid disrupting the earlier build, testing as a new service first is safer.

## Using Arcade Hub

1. Open the new Render URL.
2. Go to **Shared files**. No login or shared key is required.
3. Choose multiple files at once or upload a complete game folder. ZIP files and files with extensions other than `.exe` are accepted. Related files uploaded together are grouped.
4. For a ZIP game, upload the ZIP by itself or with any additional dependencies. For an installed game folder, choose **Choose a whole game folder**. Each uploaded group shows separate Wine, DOSBox, and ScummVM launch buttons.
5. In the shared file list, choose **Wine · Windows EXE**, **DOSBox**, or **ScummVM**. Wine picks a likely Windows EXE/MSI launcher; DOSBox picks a DOS-style EXE/COM/BAT if it can identify one, otherwise it opens a DOS prompt; ScummVM opens its launcher so you can add a supported game folder.
6. The **Remote screen** opens. noVNC displays the desktop. If it does not connect automatically, press **Connect / refresh screen**.
7. Give your friends the Render URL. Anyone with the URL can connect to and control the same running desktop.

Every file extension is accepted for storage. Wine launches EXE/MSI programs or ZIP archives containing them; DOSBox launches compatible DOS EXE/COM/BAT files or opens a DOS prompt; ScummVM opens its launcher so you can add a supported game folder. Other files (DLLs, data, configs, assets, etc.) are staged alongside the game when uploaded in the same group.

## Compatibility and graphics

- Wine supports many Win32 and Win64 programs, but compatibility varies by application.
- Older 2D Windows games and simple utilities are the best Wine test targets. DOSBox is for classic DOS software; ScummVM is for its supported adventure-game engines.
- ZIP files are extracted safely, but nested ZIP archives are not automatically unpacked recursively.
- If a folder or archive contains several EXEs, the server picks a likely launcher based on its filename and alphabetical order. This is a simple default, not a perfect game-specific detector.
- DirectX 11/12, anti-cheat, kernel drivers, UWP apps, DRM-protected games, and modern high-end 3D games are unlikely to work.
- There is no server GPU and no audio forwarding in this build. The browser renders the remote desktop frames and sends keyboard/mouse input. noVNC's on-screen keyboard can help on touch devices; gamepad-specific remapping is not included yet.
- The GameMaker error in the supplied screenshot (`Graphics_DisplayM.cpp`, HRESULT `0x80004005`) looked like a graphics initialization failure in the previous Boxedwine browser runtime. Running under server-side Wine changes the graphics stack, but it does not guarantee that the same game will work: the Free service still has software rendering only.

## Shared desktop and security

- There is one Render-side game desktop, shared by all visitors. **Anyone with the URL can upload, delete, start, or stop titles and control the active desktop.**
- The VNC server listens only on localhost. The public WebSocket gateway checks the request origin before proxying to the private websockify listener.
- This is an open public app, not a private friends-only service. Do not upload private files or untrusted programs. Anyone who discovers the URL can use the available upload and launch features; public users can fill the temporary shelf, delete shared uploads, or replace the active game session.
- Wine is launched as a non-root `arcade` user, separate from the Node server process. However, this is **not a full security sandbox**. Only run programs that you and your friends trust. Unknown EXEs can still be malicious, and this container does not promise network isolation.
- Do not upload copyrighted games unless you have permission to share them.

## Source components

- Wine: Windows compatibility layer (32-bit and 64-bit Debian packages).
- DOSBox: classic DOS x86 emulator.
- ScummVM: engine for supported classic adventure games; game data is not included.
- Xvfb + Openbox: virtual desktop and window manager.
- x11vnc + websockify + noVNC: remote screen and browser transport.
- Node.js: shared library, upload API, session launcher, per-browser recent-history cookie, and public WebSocket gateway.

For upstream project details and licenses, see the package notices supplied by the Debian image and the official Wine/noVNC projects.
