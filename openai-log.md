# Changelog

## 6.34.0 (2026-04-08)

Full Changelog: [v6.33.0...v6.34.0](https://github.com/openai/openai-node/compare/v6.33.0...v6.34.0)

### Features

* **api:** add phase field to Message in conversations ([eb7cbc1](https://github.com/openai/openai-node/commit/eb7cbc1cb9d8f3189b4db6b59a6ff2c45376a598))
* **client:** add support for short-lived tokens ([#839](https://github.com/openai/openai-node/issues/839)) ([a72ebcf](https://github.com/openai/openai-node/commit/a72ebcf06bcbf4100a3f3c8723b66c34f7c261ec))


### Bug Fixes

* **api:** remove web_search_call.results from ResponseIncludable in responses ([1f6968e](https://github.com/openai/openai-node/commit/1f6968e1c0add39034d26f4268a75cadad42abf0))


### Chores

* **internal:** codegen related update ([1081460](https://github.com/openai/openai-node/commit/1081460b68a90915fb019f81d9c24c0dfa48a3c4))
* **internal:** update multipart form array serialization ([3faee8d](https://github.com/openai/openai-node/commit/3faee8da8d286871adb3ce1258df57aab67272da))
* **tests:** bump steady to v0.20.1 ([b73cc6b](https://github.com/openai/openai-node/commit/b73cc6b9db6489b7e8b55cab79789ddb21e6d83f))


### Documentation

* **api:** add multi-file ingestion recommendations to vector-stores files/file-batches ([1bc32a3](https://github.com/openai/openai-node/commit/1bc32a3cbc4d453e2835db3a1844e7c99f55df24))

## 6.33.0 (2026-03-25)

Full Changelog: [v6.32.0...v6.33.0](https://github.com/openai/openai-node/compare/v6.32.0...v6.33.0)

### Features

* **api:** add keys field to computer action types ([27a850e](https://github.com/openai/openai-node/commit/27a850e8a698cde5b7e05da70d8babb1205b2830))
* **client:** add async iterator and stream() to WebSocket classes ([e1c16ee](https://github.com/openai/openai-node/commit/e1c16ee35b8ef9db30e9a99a2b3460368f3044d0))


### Bug Fixes

* **api:** align SDK response types with expanded item schemas ([491cd52](https://github.com/openai/openai-node/commit/491cd5290c36e6b1de7ff9787e80c73899d8b642))
* **types:** make type required in ResponseInputMessageItem ([2012293](https://github.com/openai/openai-node/commit/20122931977c2de8630cb03182766fbf6dc37868))


### Chores

* **ci:** skip lint on metadata-only changes ([74a917f](https://github.com/openai/openai-node/commit/74a917fd92dd2a1bd3089f3b5f79781bdc0d4ec3))
* **internal:** refactor imports ([cfe9c60](https://github.com/openai/openai-node/commit/cfe9c60aa41e9ed53e7d5f9187d31baf4364f8bd))
* **internal:** update gitignore ([71bd114](https://github.com/openai/openai-node/commit/71bd114f97e24c547660694d03c19b22d62ae961))
* **tests:** bump steady to v0.19.4 ([f2e9dea](https://github.com/openai/openai-node/commit/f2e9dea844405f189cc63a1d1493de3eabfcb7e7))
* **tests:** bump steady to v0.19.5 ([37c6cf4](https://github.com/openai/openai-node/commit/37c6cf495b9a05128572f9e955211b67d01410f3))
* **tests:** bump steady to v0.19.6 ([496b3af](https://github.com/openai/openai-node/commit/496b3af4371cf40f5d14f72d0770e152710b09df))
* **tests:** bump steady to v0.19.7 ([8491eb6](https://github.com/openai/openai-node/commit/8491eb6d83cf8680bdc9d69e60b8e5d09e2bc8e8))


### Refactors

* **tests:** switch from prism to steady ([47c0581](https://github.com/openai/openai-node/commit/47c0581a1923c9e700a619dd6bfa3fb93a188899))

## 6.32.0 (2026-03-17)

Full Changelog: [v6.31.0...v6.32.0](https://github.com/openai/openai-node/compare/v6.31.0...v6.32.0)

### Features

* **api:** 5.4 nano and mini model slugs ([068df6d](https://github.com/openai/openai-node/commit/068df6d625d7faa76dfac160065f1ca550539ba8))

## 6.31.0 (2026-03-16)

Full Changelog: [v6.30.1...v6.31.0](https://github.com/openai/openai-node/compare/v6.30.1...v6.31.0)

### Features

* **api:** add in/nin filter types to ComparisonFilter ([b2eda27](https://github.com/openai/openai-node/commit/b2eda274418ceb9bbdb3778cb6a5ee28090df8ad))

## 6.30.1 (2026-03-16)

Full Changelog: [v6.30.0...v6.30.1](https://github.com/openai/openai-node/compare/v6.30.0...v6.30.1)

### Chores

* **internal:** tweak CI branches ([25f5d74](https://github.com/openai/openai-node/commit/25f5d74c1fc16e3303fcb87022f5f0559b052cbf))

## 6.30.0 (2026-03-16)

Full Changelog: [v6.29.0...v6.30.0](https://github.com/openai/openai-node/compare/v6.29.0...v6.30.0)

### Features

* **api:** add /v1/videos endpoint option to batches ([271d879](https://github.com/openai/openai-node/commit/271d87979f16950900f4253915bdda319b7fe935))
* **api:** add defer_loading field to NamespaceTool ([7cc8f0a](https://github.com/openai/openai-node/commit/7cc8f0a736ea7ba0aa3e7860b4c30eaaa5795966))


### Bug Fixes

* **api:** oidc publishing for npm ([fa50066](https://github.com/openai/openai-node/commit/fa500666e38379f2241ac43d60e2eb7eef7d39cb))

## 6.29.0 (2026-03-13)

Full Changelog: [v6.28.0...v6.29.0](https://github.com/openai/openai-node/compare/v6.28.0...v6.29.0)

### Features

* **api:** custom voices ([a11307a](https://github.com/openai/openai-node/commit/a11307afab49299fdf7e7ed3675d3e277d9b5c60))

## 6.28.0 (2026-03-13)

Full Changelog: [v6.27.0...v6.28.0](https://github.com/openai/openai-node/compare/v6.27.0...v6.28.0)

### Features

* **api:** manual updates ([d543959](https://github.com/openai/openai-node/commit/d54395976aa4c1c1864bb45dbaf81ec1d66b8c6b))
* **api:** manual updates ([4f87840](https://github.com/openai/openai-node/commit/4f878406e029ae7527201251632e3fa00b800045))
* **api:** sora api improvements: character api, video extensions/edits, higher resolution exports. ([262dac2](https://github.com/openai/openai-node/commit/262dac25aec6c9caa561f57a0b9e2a086f47a26a))


### Bug Fixes

* **types:** remove detail field from ResponseInputFile and ResponseInputFileContent ([8d6c0cd](https://github.com/openai/openai-node/commit/8d6c0cdbbf08829db08745597e1806661534853f))


### Chores

* **internal:** update dependencies to address dependabot vulnerabilities ([f5810ee](https://github.com/openai/openai-node/commit/f5810ee5f5bf96e81a77f91939f3d56427c46e00))
* match http protocol with ws protocol instead of wss ([6f4e936](https://github.com/openai/openai-node/commit/6f4e936bc2211da885bf492615b2bf413887576b))
* **mcp-server:** improve instructions ([aad9ca1](https://github.com/openai/openai-node/commit/aad9ca15ddbb8dbc27ed6b2aa9b242af9bbf7b8f))
* use proper capitalization for WebSockets ([cb4cf62](https://github.com/openai/openai-node/commit/cb4cf6297c2a0eb7d3f55f8850e6e8ffc4c7ecc6))

## 6.27.0 (2026-03-05)

Full Changelog: [v6.26.0...v6.27.0](https://github.com/openai/openai-node/compare/v6.26.0...v6.27.0)

### Features

* **api:** The GA ComputerTool now uses the CompuerTool class. The 'computer_use_preview' tool is moved to ComputerUsePreview ([0206188](https://github.com/openai/openai-node/commit/0206188f760be830738136e37dcf7be6ea0fe20c))


### Chores

* **internal:** improve import alias names ([9cc2478](https://github.com/openai/openai-node/commit/9cc24789730a309037ef81f5a30af515d700459a))

## 6.26.0 (2026-03-05)

Full Changelog: [v6.25.0...v6.26.0](https://github.com/openai/openai-node/compare/v6.25.0...v6.26.0)

### Features

* **api:** gpt-5.4, tool search tool, and new computer tool ([1d1e5a9](https://github.com/openai/openai-node/commit/1d1e5a9b5aeb11b0e940b4532dcd6a3fcc23898a))


### Bug Fixes

* **api:** internal schema fixes ([6b401ad](https://github.com/openai/openai-node/commit/6b401ad7d3ff2ead9cfa577daf8381f62ea85b93))
* **api:** manual updates ([2b54919](https://github.com/openai/openai-node/commit/2b549195c70581022d9d64c443ab08202c6faeb7))
* **api:** readd phase ([4a0cf29](https://github.com/openai/openai-node/commit/4a0cf2974865519d3b512fb377bc4ba305dce7b7))
* **api:** remove phase from message types, prompt_cache_key param in responses ([088fca6](https://github.com/openai/openai-node/commit/088fca6a4d5d1a577500acb5579ee403292d8911))


### Chores

* **internal:** codegen related update ([6a0aa9e](https://github.com/openai/openai-node/commit/6a0aa9e2ff10e78f8b9afd777174d16537a29c8e))
* **internal:** codegen related update ([b2a4299](https://github.com/openai/openai-node/commit/b2a42991cbe83eee45a342f19a5a99ce1d78b36a))
* **internal:** move stringifyQuery implementation to internal function ([f9f4660](https://github.com/openai/openai-node/commit/f9f46609cf5c1fc51e437c23251c5a7d0519d55d))
* **internal:** reduce warnings ([7e19492](https://github.com/openai/openai-node/commit/7e194929156052b0efbda9ca48c3ed6de8c18d2f))

## 6.25.0 (2026-02-24)

Full Changelog: [v6.24.0...v6.25.0](https://github.com/openai/openai-node/compare/v6.24.0...v6.25.0)

### Features

* **api:** add phase ([e32b853](https://github.com/openai/openai-node/commit/e32b853c3c57f2d0e4c05b09177b94677aed0e5a))


### Bug Fixes

* **api:** fix phase enum ([2ffe1be](https://github.com/openai/openai-node/commit/2ffe1be2600d0154b3355eefa61707470a341a95))
* **api:** phase docs ([7fdfa38](https://github.com/openai/openai-node/commit/7fdfa38c1fa2bd383e1171510918c6db5f0937d8))


### Chores

* **internal:** refactor sse event parsing ([0ea2380](https://github.com/openai/openai-node/commit/0ea238054c0473adc97f4173a0ad5ba8bcfa4e29))

## 6.24.0 (2026-02-24)

Full Changelog: [v6.23.0...v6.24.0](https://github.com/openai/openai-node/compare/v6.23.0...v6.24.0)

### Features

* **api:** add gpt-realtime-1.5 and gpt-audio-1.5 models to realtime ([75875bf](https://github.com/openai/openai-node/commit/75875bfb850c0780878553c566fe8821048ae5e8))

## 6.23.0 (2026-02-23)

Full Changelog: [v6.22.0...v6.23.0](https://github.com/openai/openai-node/compare/v6.22.0...v6.23.0)

### Features

* **api:** websockets for responses api ([c6b96b8](https://github.com/openai/openai-node/commit/c6b96b8b8d5f8132e0a4c5f7399a04185302adcc))

