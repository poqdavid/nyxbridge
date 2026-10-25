# NyxBridge notices

NyxBridge
Copyright (C) 2026 poqdavid

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program (see `LICENSE`). If not, see
<https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-only
Source code: <https://github.com/poqdavid/nyxbridge>

## Shared with NyxSUSFS and NyxProps

The WebUI framework (`webui/src/core/`: the manager bridge, i18n, theme,
fullscreen, keyboard, sheet, dialog and icons; `css/tokens.css` and the
base of `css/app.css`), the WebUI build (`webui/build.mjs`,
`webui/tsconfig.json`), the installer's integrity check
(`module/verify.sh`), `scripts/gen-hashes.sh`, the build workflow and its
Telegram post (`.github/scripts/telegram.py`) come from **NyxSUSFS**
(<https://github.com/poqdavid/nyxsusfs>) and **NyxProps**
(<https://github.com/poqdavid/nyxprops>) by the same author, under the same
license.

## Projects NyxBridge works with

- **VirtualAP** by ravindu644 — <https://github.com/ravindu644/VirtualAP>:
  NyxBridge reads VirtualAP's `run.state` and attaches to the bridge it
  creates in managed mode. No VirtualAP code is included.
- **Droidspaces** by ravindu644 — <https://github.com/ravindu644/Droidspaces-OSS>:
  runs the container VirtualAP hands the hotspot to. NyxBridge's rule
  priority is chosen to sit next to Droidspaces' 6090–6100 rules without
  touching them. No Droidspaces code is included.

## Ideas reimplemented, not copied

- **droidspaces-lan-ip** by yashoswalyo —
  <https://github.com/yashoswalyo/droidspaces-lan-ip>: the idea of a
  low-priority `to <subnet> lookup main` rule so Android's policy routing
  reaches an interface netd doesn't manage, and of a background worker that
  re-applies the setup when the network underneath it is recreated.
  NyxBridge implements these in its own code; none of droidspaces-lan-ip's
  code is included.
- **Duck ToolBox** by Eltavine, MIT — <https://github.com/eltavine/Duck-ToolBox>:
  the CI job layout, the Telegram build caption and the installer checks.

## Icons

Most WebUI icons in `webui/src/core/icons.ts` are hand-drawn in the
rounded Material Symbols style. The `tune`, `close`, `devices`, `router`
and `copy` icons use path geometry from **Material Icons** by Google
(Apache License 2.0, <https://github.com/google/material-design-icons>);
see `module/LICENSE.material-icons`.

## Built from source

- `module/bin/nyxbridge` is built from the Rust sources in `src/`. It has
  **no third-party crate dependencies** — only the Rust standard library —
  so no additional licenses are bundled on its account.
- `module/webroot/js/app.js` is bundled from the TypeScript sources in
  `webui/src/` by esbuild. TypeScript and esbuild are build tools only; the
  bundle contains no third-party code.
