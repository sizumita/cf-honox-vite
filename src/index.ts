import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { Miniflare, type MiniflareOptions } from "miniflare"
import { minimatch } from "minimatch"
import honox from "honox/vite"
import {
  build,
  mergeConfig,
  normalizePath,
  type InlineConfig,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer
} from "vite"
import {
  createBasePathGuard,
  createBasePathRewriter,
  safeParseUrlPath
} from "./utils.js"

type Pattern = RegExp | string

export type MiniflareDevServerOptions = {
  entry?: string
  base?: string
  injectClientScript?: boolean
  exclude?: Pattern[]
  ignoreWatching?: Pattern[]
  outDir?: string
  reloadDebounceMs?: number
  build?: {
    minify?: boolean
    sourcemap?: boolean
    target?: string
  }
  miniflare?: MiniflareOptions
}

export type CfHonoxViteOptions = {
  honox?: Parameters<typeof honox>[0]
  devServer?: MiniflareDevServerOptions
}

const pluginName = "cf-honox-vite:miniflare-dev-server"

export const defaultOptions = {
  entry: "./app/server.ts",
  injectClientScript: true,
  exclude: [
    /.*\.css$/,
    /.*\.ts$/,
    /.*\.tsx$/,
    /.*\.mdx?$/,
    /^\/@.+$/,
    /\?t\=\d+$/,
    /[?&]tsr-split=[^&]*(&t=[^&]*)?$/,
    /^\/app\/.+\.tsx?/,
    /^\/favicon\.ico$/,
    /^\/static\/.+/,
    /^\/node_modules\/.*/,
    /.*\.svelte$/,
    /.*\.vue$/,
    /.*\.js$/,
    /.*\.jsx$/
  ] satisfies Pattern[],
  ignoreWatching: [/\.wrangler/, /\.mf/, /\.git/] satisfies Pattern[],
  outDir: ".mf/cf-honox-vite",
  reloadDebounceMs: 80
} as const

const coerceArray = <T>(value?: T | T[]): T[] =>
  value ? (Array.isArray(value) ? value : [value]) : []

const matchPattern = (pattern: Pattern, target: string) => {
  if (pattern instanceof RegExp) {
    return pattern.test(target)
  }
  return minimatch(target, pattern, { dot: true })
}

const shouldIgnorePath = (filePath: string, patterns: Pattern[]) => {
  const normalized = normalizePath(filePath)
  return patterns.some((pattern) => matchPattern(pattern, normalized))
}

const buildWorkerConfig = (
  config: ResolvedConfig,
  entry: string,
  outDir: string,
  options: MiniflareDevServerOptions
): InlineConfig => {
  const ssrExternal = new Set<string>()
  for (const value of coerceArray(config.ssr?.external)) {
    if (typeof value === "string") {
      ssrExternal.add(value)
    }
  }
  ssrExternal.add("cloudflare:workers")

  const rollupOutput = {
    ...(Array.isArray(config.build?.rollupOptions?.output)
      ? {}
      : (config.build?.rollupOptions?.output ?? {})),
    entryFileNames: "worker.mjs",
    format: "es"
  }

  return mergeConfig(
    {
      configFile: false,
      root: config.root,
      publicDir: false,
      plugins: config.plugins.filter((plugin) => plugin.name !== pluginName),
      ssr: {
        ...(config.ssr ?? {}),
        external: Array.from(ssrExternal)
      },
      build: {
        ...(config.build ?? {}),
        ssr: entry,
        outDir,
        emptyOutDir: false,
        minify: options.build?.minify ?? false,
        sourcemap: options.build?.sourcemap ?? true,
        target: options.build?.target ?? "es2022",
        rollupOptions: {
          ...(config.build?.rollupOptions ?? {}),
          input: entry,
          output: rollupOutput
        }
      }
    },
    {}
  )
}

const createWorkerRequest = async (
  req: import("node:http").IncomingMessage
) => {
  const method = req.method ?? "GET"
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      headers.set(key, value.join(","))
    } else {
      headers.set(key, value)
    }
  }
  let body: Buffer | undefined
  if (!["GET", "HEAD"].includes(method)) {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    body = Buffer.concat(chunks)
  }
  return new Request(url, {
    method,
    headers,
    body
  })
}

const injectStringToResponse = async (
  response: Response,
  content: string
): Promise<Response> => {
  const text = await response.text()
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(text + content, {
    status: response.status,
    headers
  })
}

const sendResponse = async (
  res: import("node:http").ServerResponse,
  response: Response
) => {
  res.statusCode = response.status
  const setCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
  if (setCookie) {
    res.setHeader("set-cookie", setCookie)
  }
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return
    res.setHeader(key, value)
  })
  if (response.body) {
    const nodeStream = Readable.fromWeb(response.body)
    nodeStream.pipe(res)
  } else {
    res.end()
  }
}

export const miniflareDevServer = (
  options: MiniflareDevServerOptions = {}
): Plugin => {
  let config: ResolvedConfig
  let publicDirPath = ""
  let viteBase = "/"
  let mf: Miniflare | undefined
  let rebuildTimer: NodeJS.Timeout | undefined
  let buildInProgress = false
  let buildQueued = false

  const entry = options.entry ?? defaultOptions.entry
  const outDir = options.outDir ?? defaultOptions.outDir
  const excludePatterns = options.exclude ?? defaultOptions.exclude
  const ignoreWatching = options.ignoreWatching ?? defaultOptions.ignoreWatching
  const shouldHandlePath = createBasePathGuard(options.base)
  const rewriteRequestForBase = createBasePathRewriter(options.base)

  const scheduleRebuild = (server: ViteDevServer) => {
    const debounce = options.reloadDebounceMs ?? defaultOptions.reloadDebounceMs
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      void rebuildWorker(server)
    }, debounce)
  }

  const rebuildWorker = async (server: ViteDevServer) => {
    if (buildInProgress) {
      buildQueued = true
      return
    }
    buildInProgress = true
    try {
      const absoluteEntry = path.isAbsolute(entry)
        ? entry
        : path.resolve(config.root, entry)
      const absoluteOutDir = path.resolve(config.root, outDir)
      const buildConfig = buildWorkerConfig(
        config,
        absoluteEntry,
        absoluteOutDir,
        options
      )
      await build(buildConfig)
      const scriptPath = path.join(absoluteOutDir, "worker.mjs")
      const mfOptions: MiniflareOptions = {
        ...(options.miniflare ?? {}),
        modules: true,
        scriptPath,
        compatibilityDate:
          options.miniflare?.compatibilityDate ??
          new Date().toISOString().slice(0, 10)
      }
      if (!mf) {
        mf = new Miniflare(mfOptions)
      } else {
        await mf.setOptions(mfOptions)
      }
      server.hot.send({ type: "full-reload" })
    } finally {
      buildInProgress = false
      if (buildQueued) {
        buildQueued = false
        await rebuildWorker(server)
      }
    }
  }

  return {
    name: pluginName,
    config: () => {
      const baseOption = options.base
      return {
        ...(baseOption !== undefined
          ? { base: baseOption === "" ? "/" : baseOption }
          : {}),
        server: {
          watch: {
            ignored: ignoreWatching
          }
        }
      }
    },
    configResolved(resolved) {
      config = resolved
      publicDirPath = resolved.publicDir
      viteBase = resolved.base
    },
    configureServer: async (server) => {
      await rebuildWorker(server)
      server.watcher.on("all", (_event, file) => {
        const absoluteOutDir = path.resolve(config.root, outDir)
        if (
          shouldIgnorePath(file, ignoreWatching) ||
          normalizePath(file).startsWith(normalizePath(absoluteOutDir))
        ) {
          return
        }
        scheduleRebuild(server)
      })
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !mf) return next()
        try {
          if (publicDirPath) {
            const pathname = safeParseUrlPath(req.url)
            if (pathname) {
              const filePath = path.join(publicDirPath, pathname)
              if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return next()
              }
            }
          }
          for (const pattern of excludePatterns) {
            if (matchPattern(pattern, req.url)) {
              return next()
            }
          }
          const pathname = safeParseUrlPath(req.url)
          if (!shouldHandlePath(pathname)) {
            return next()
          }
          let request = await createWorkerRequest(req)
          if (rewriteRequestForBase) {
            request = rewriteRequestForBase(request)
          }
          let response = await mf.dispatchFetch(request)
          if (
            options.injectClientScript ?? defaultOptions.injectClientScript
          ) {
            const contentType = response.headers.get("content-type")
            if (contentType?.match(/^text\/html/)) {
              const viteScript = path.posix.join(viteBase, "/@vite/client")
              const nonce = response
                .headers
                .get("content-security-policy")
                ?.match(/'nonce-([^']+)'/)?.[1]
              const script = `<script${nonce ? ` nonce=\"${nonce}\"` : ""}>import(\"${viteScript}\")</script>`
              response = await injectStringToResponse(response, script)
            }
          }
          await sendResponse(res, response)
        } catch (error) {
          next(error)
        }
      })
      server.httpServer?.on("close", async () => {
        if (mf) {
          await mf.dispose()
        }
      })
    }
  }
}

export default function cfHonoxVite(
  options: CfHonoxViteOptions = {}
): Plugin[] {
  const honoxOptions = options.honox ?? {}
  const devServerOptions = (honoxOptions as { devServer?: any }).devServer ?? {}
  const disabledDevServer = {
    ...devServerOptions,
    exclude: [...coerceArray(devServerOptions.exclude), /.*/]
  }
  const honoxPlugins = honox({
    ...(honoxOptions as Parameters<typeof honox>[0]),
    devServer: disabledDevServer
  })
  return [...honoxPlugins, miniflareDevServer(options.devServer)]
}
