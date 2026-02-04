# cf-honox-vite

Miniflare-based dev server adapter for **HonoX + Vite**.
`@hono/vite-dev-server` が Node 上で動いて `cloudflare:workers` を import できない問題を回避し、
Cloudflare Workers 互換の実行環境（Miniflare）で dev できます。

## Install

```bash
pnpm add -D cf-honox-vite miniflare
# or
npm i -D cf-honox-vite miniflare
```

## Usage (recommended)

`honox/vite` 相当の設定をまとめて行うラッパーを用意しています。

```ts
import { defineConfig } from "vite"
import cfHonoxVite from "cf-honox-vite"

export default defineConfig({
  plugins: [cfHonoxVite()]
})
```

## Usage (manual)

```ts
import { defineConfig } from "vite"
import honox from "honox/vite"
import { miniflareDevServer } from "cf-honox-vite"

export default defineConfig({
  plugins: [
    ...honox({ devServer: { exclude: [/.*/] } }),
    miniflareDevServer({
      miniflare: {
        compatibilityDate: "2026-02-04"
      }
    })
  ]
})
```

## Options

`miniflareDevServer(options)`

- `entry` (default: `./app/server.ts`)
- `base`
- `injectClientScript` (default: `true`)
- `exclude` (Vite に任せるパスの除外パターン)
- `ignoreWatching` (再ビルド監視から除外)
- `outDir` (default: `.mf/cf-honox-vite`)
- `reloadDebounceMs`
- `build`: `{ minify, sourcemap, target }`
- `miniflare`: `MiniflareOptions`（`scriptPath`/`modules` は内部で上書き）

## Notes / Limitations

- SSR 側の更新は **full reload**（HMR ではなく全体リロード）。
- 変更時に Vite の SSR ビルドを走らせるため、規模によっては遅くなる場合があります。
- `cloudflare:workers` など Worker 専用 import を dev で扱えることを目的としています。

## Example

このリポジトリに最小の HonoX 例を同梱しています。

```bash
pnpm install
pnpm dev
```

