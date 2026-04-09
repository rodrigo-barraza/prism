# Changelog

## 0.86.1 (2026-04-08)

Full Changelog: [sdk-v0.86.0...sdk-v0.86.1](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.86.0...sdk-v0.86.1)

### Chores

* update @anthropic-ai/sdk dependency version ([#870](https://github.com/anthropics/anthropic-sdk-typescript/issues/870)) ([036342b](https://github.com/anthropics/anthropic-sdk-typescript/commit/036342bdbf9867e223465510d4a39146f1b721dd))

## 0.86.0 (2026-04-08)

Full Changelog: [sdk-v0.85.0...sdk-v0.86.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.85.0...sdk-v0.86.0)

### Features

* **api:** add support for Claude Managed Agents ([2ef732a](https://github.com/anthropics/anthropic-sdk-typescript/commit/2ef732a1df5cfb4bf65f274e3662c5fb8fe78af4))


### Chores

* **internal:** codegen related update ([d644830](https://github.com/anthropics/anthropic-sdk-typescript/commit/d644830d59179881abe4ba2a2d56d17aa784a8c3))

## 0.85.0 (2026-04-07)

Full Changelog: [sdk-v0.84.0...sdk-v0.85.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.84.0...sdk-v0.85.0)

### Features

* **client:** Create Bedrock Mantle client ([#810](https://github.com/anthropics/anthropic-sdk-typescript/issues/810)) ([2f1f4a1](https://github.com/anthropics/anthropic-sdk-typescript/commit/2f1f4a1f565a6c12afc1dd7fd98d2adf735dd68b))

## 0.84.0 (2026-04-07)

Full Changelog: [sdk-v0.83.0...sdk-v0.84.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.83.0...sdk-v0.84.0)

### Features

* **api:** Add support for claude-mythos-preview ([d4057b0](https://github.com/anthropics/anthropic-sdk-typescript/commit/d4057b0a9559d9a620e6a398a4199f5a416bc7a6))
* **tools:** add AbortSignal support for tool runner ([#848](https://github.com/anthropics/anthropic-sdk-typescript/issues/848)) ([972d591](https://github.com/anthropics/anthropic-sdk-typescript/commit/972d5918a4d24b15686c8c407860cbfed4215ffa))

## 0.83.0 (2026-04-03)

Full Changelog: [sdk-v0.82.0...sdk-v0.83.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.82.0...sdk-v0.83.0)

### Features

* **vertex:** add support for US multi-region endpoint ([5e5aea7](https://github.com/anthropics/anthropic-sdk-typescript/commit/5e5aea72e8af1d0cd0af7770f7c98a716fa24629))
* **vertex:** add support for US multi-region endpoint ([0de0e98](https://github.com/anthropics/anthropic-sdk-typescript/commit/0de0e98aace311d7f6b5617b597d73324de73e2f))


### Bug Fixes

* **client:** dont upload aws artifact ([#844](https://github.com/anthropics/anthropic-sdk-typescript/issues/844)) ([d1a31fc](https://github.com/anthropics/anthropic-sdk-typescript/commit/d1a31fcd591d61d3bd2a4cb1b0b5cfcf2f66f5fe))


### Chores

* **client:** deprecate client-side compaction helpers ([1926e87](https://github.com/anthropics/anthropic-sdk-typescript/commit/1926e870393b653ac87c4fb9e521a8a44786ab49))
* **client:** internal updates ([3d64763](https://github.com/anthropics/anthropic-sdk-typescript/commit/3d6476315480508cff8462a5b4523944579dbd32))

## 0.82.0 (2026-04-01)

Full Changelog: [sdk-v0.81.0...sdk-v0.82.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.81.0...sdk-v0.82.0)

### Features

* **api:** add structured stop_details to message responses ([031328a](https://github.com/anthropics/anthropic-sdk-typescript/commit/031328a1b43ec72fb4bb5a77c79ee6c275694a20))
* prepare aws package ([#782](https://github.com/anthropics/anthropic-sdk-typescript/issues/782)) ([f351d4d](https://github.com/anthropics/anthropic-sdk-typescript/commit/f351d4dfeb57b48bcb126686dc608493813262da))
* support API keys in Bedrock SDK ([#824](https://github.com/anthropics/anthropic-sdk-typescript/issues/824)) ([be6c608](https://github.com/anthropics/anthropic-sdk-typescript/commit/be6c608bf0de9ceb2c09974b28f7f80db96ed42e))


### Chores

* **tests:** bump steady to v0.20.2 ([6cf12cc](https://github.com/anthropics/anthropic-sdk-typescript/commit/6cf12cc819733e241b3a1effaff3fcbc96e94476))

## 0.81.0 (2026-03-31)

Full Changelog: [sdk-v0.80.0...sdk-v0.81.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.80.0...sdk-v0.81.0)

### Features

* add .type field to APIError for error kind identification ([#790](https://github.com/anthropics/anthropic-sdk-typescript/issues/790)) ([4bf637d](https://github.com/anthropics/anthropic-sdk-typescript/commit/4bf637d962c2203ca7977d4e5447e2b083e29188))


### Bug Fixes

* **memory:** append path separator in validatePath prefix check ([0ac69b3](https://github.com/anthropics/anthropic-sdk-typescript/commit/0ac69b3438ee9c96b21a7d3c39c07b7cdb6995d9))


### Chores

* **ci:** run builds on CI even if only spec metadata changed ([70b657a](https://github.com/anthropics/anthropic-sdk-typescript/commit/70b657aac1be76e941885dfe9d683c45a57ad005))
* **ci:** skip lint on metadata-only changes ([69bdc94](https://github.com/anthropics/anthropic-sdk-typescript/commit/69bdc94a16e5402b8fd19d54a1f4695cba834dbb))
* **internal:** codegen related update ([7ff7390](https://github.com/anthropics/anthropic-sdk-typescript/commit/7ff7390029867195adf78e6dbfaa43d8bb0a9720))
* **internal:** update gitignore ([46d6667](https://github.com/anthropics/anthropic-sdk-typescript/commit/46d66675d59da125c0a00cc8feb6a13bc6105637))
* **internal:** update multipart form array serialization ([d55b07d](https://github.com/anthropics/anthropic-sdk-typescript/commit/d55b07d4f791763738fd54a032cd421b6d16d151))
* **tests:** bump steady to v0.19.4 ([4957a5e](https://github.com/anthropics/anthropic-sdk-typescript/commit/4957a5e65bdc77528f81c123ec2865784c064055))
* **tests:** bump steady to v0.19.5 ([c511ae0](https://github.com/anthropics/anthropic-sdk-typescript/commit/c511ae042129805400c5286a02d3c45f49e51ca6))
* **tests:** bump steady to v0.19.6 ([6d2b4b9](https://github.com/anthropics/anthropic-sdk-typescript/commit/6d2b4b910a687c2cf73bb51450ce24c704fdc384))
* **tests:** bump steady to v0.19.7 ([d6cff9d](https://github.com/anthropics/anthropic-sdk-typescript/commit/d6cff9d2c8688fb95dc6af0f89ae33480f9758e0))
* **tests:** bump steady to v0.20.1 ([284561f](https://github.com/anthropics/anthropic-sdk-typescript/commit/284561fe36b244f5b6ab624ec2608c07f71f476e))

## 0.80.0 (2026-03-18)

Full Changelog: [sdk-v0.79.0...sdk-v0.80.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.79.0...sdk-v0.80.0)

### Features

* **api:** manual updates ([dd12f1a](https://github.com/anthropics/anthropic-sdk-typescript/commit/dd12f1a29c4a8f4554caa8c7023bddadfb69e9b0))
* **api:** manual updates ([9c0a077](https://github.com/anthropics/anthropic-sdk-typescript/commit/9c0a0778d73ffe2f84cf4a3d593f8f645d776b02))


### Chores

* **internal:** tweak CI branches ([4a5819e](https://github.com/anthropics/anthropic-sdk-typescript/commit/4a5819e9e820a926add4df134a6a4d6d0e65c196))

## 0.79.0 (2026-03-16)

Full Changelog: [sdk-v0.78.0...sdk-v0.79.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.78.0...sdk-v0.79.0)

### Features

* add support for filesystem memory tools ([#599](https://github.com/anthropics/anthropic-sdk-typescript/issues/599)) ([1064199](https://github.com/anthropics/anthropic-sdk-typescript/commit/106419918ec0098cd74df5541dd7fd9134268f6e))
* **api:** chore(config): clean up model enum list ([#31](https://github.com/anthropics/anthropic-sdk-typescript/issues/31)) ([07727a6](https://github.com/anthropics/anthropic-sdk-typescript/commit/07727a63c4d3685a20de3067a563396b2d2adbb2))
* **api:** GA thinking-display-setting ([4dc8df4](https://github.com/anthropics/anthropic-sdk-typescript/commit/4dc8df4b7d098b7e748ca952ac18e5e22264a4c8))
* **tests:** update mock server ([e5c3be9](https://github.com/anthropics/anthropic-sdk-typescript/commit/e5c3be981177874b4f9ab5d1a56e4c8cfb7a6744))


### Bug Fixes

* **docs/contributing:** correct pnpm link command ([16bf66c](https://github.com/anthropics/anthropic-sdk-typescript/commit/16bf66c4ab9334f2f817f29e8834ff82f1689e9e))
* **internal:** skip tests that depend on mock server ([07417e5](https://github.com/anthropics/anthropic-sdk-typescript/commit/07417e521b35b01670cb0334aa3f23e77ba38cbc))
* **zod:** use v4 import path for Zod ^3.25 compatibility ([#925](https://github.com/anthropics/anthropic-sdk-typescript/issues/925)) ([c6c0ac8](https://github.com/anthropics/anthropic-sdk-typescript/commit/c6c0ac8a3091ad83890fb6813e4a0ee2a6e45bba))


### Chores

* **client:** remove unused import ([3827ab5](https://github.com/anthropics/anthropic-sdk-typescript/commit/3827ab5d56d37b659cfa7b25f16a42f41ad99b29))
* **internal:** codegen related update ([2c1fc10](https://github.com/anthropics/anthropic-sdk-typescript/commit/2c1fc106f8c83a13bda1a7f755e53120b3c3919d))
* **internal:** improve import alias names ([5b9615b](https://github.com/anthropics/anthropic-sdk-typescript/commit/5b9615b51007cc0bb9cea9de9dc5f2acc9fa77e8))
* **internal:** move stringifyQuery implementation to internal function ([16239f3](https://github.com/anthropics/anthropic-sdk-typescript/commit/16239f3bd4efddaf01a35a182014131e983ee738))
* **internal:** update dependencies to address dependabot vulnerabilities ([6fdea5e](https://github.com/anthropics/anthropic-sdk-typescript/commit/6fdea5ebdf767da93bff7e55a7035772610ba287))
* **mcp-server:** improve instructions ([66e5363](https://github.com/anthropics/anthropic-sdk-typescript/commit/66e5363c114c2c5950a4a1674c1264c30619bc43))
* remove accidentally committed file ([#929](https://github.com/anthropics/anthropic-sdk-typescript/issues/929)) ([0989113](https://github.com/anthropics/anthropic-sdk-typescript/commit/0989113a5a34fbf85a2a0f87b5ab78ea7d297fd4))
* **tests:** unskip tests that are now supported in steady ([616a98a](https://github.com/anthropics/anthropic-sdk-typescript/commit/616a98a2363b3c77ebd4bc54eaae1b9003d323f9))


### Documentation

* streamline and standardize docs ([#687](https://github.com/anthropics/anthropic-sdk-typescript/issues/687)) ([dbdc5d3](https://github.com/anthropics/anthropic-sdk-typescript/commit/dbdc5d3c8246732c9b477a1503618243e13e9bd6))

## 0.78.0 (2026-02-19)

Full Changelog: [sdk-v0.77.0...sdk-v0.78.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.77.0...sdk-v0.78.0)

### Features

* **api:** Add top-level cache control (automatic caching) ([1e2f83d](https://github.com/anthropics/anthropic-sdk-typescript/commit/1e2f83d0bb2c3e98302d1b17fcb4888b17889f6d))


### Bug Fixes

* **bedrock:** eliminate race condition in AWS credential resolution ([#901](https://github.com/anthropics/anthropic-sdk-typescript/issues/901)) ([e5a101d](https://github.com/anthropics/anthropic-sdk-typescript/commit/e5a101d060cdce65872ec787e792c94799dcc295))
* **client:** format batches test file ([821e9bf](https://github.com/anthropics/anthropic-sdk-typescript/commit/821e9bf13db32c8b632352292948f64a057a9d55))
* **tests:** fix issue in batches test ([5f4ccf8](https://github.com/anthropics/anthropic-sdk-typescript/commit/5f4ccf8779e69226a5c9307e3422f6779e8fda6b))


### Chores

* update mock server docs ([25d337f](https://github.com/anthropics/anthropic-sdk-typescript/commit/25d337f484b9236b03e26e1f4c67b1a2d96c6c23))

## 0.77.0 (2026-02-18)

Full Changelog: [sdk-v0.76.0...sdk-v0.77.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.76.0...sdk-v0.77.0)

### Features

* **api:** fix shared UserLocation and error code types ([c84038f](https://github.com/anthropics/anthropic-sdk-typescript/commit/c84038f4eddafc2c5415ab4eaef40326b7af376c))


### Bug Fixes

* add backward-compat namespace re-exports for UserLocation ([#706](https://github.com/anthropics/anthropic-sdk-typescript/issues/706)) ([b88834f](https://github.com/anthropics/anthropic-sdk-typescript/commit/b88834fc82bb9d1ae0cf16bd264d5ef4d1edbcff))

## 0.76.0 (2026-02-18)

Full Changelog: [sdk-v0.75.0...sdk-v0.76.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.75.0...sdk-v0.76.0)

### Features

* **api:** manual updates ([25fe41c](https://github.com/anthropics/anthropic-sdk-typescript/commit/25fe41cdf61a1d8c0a5700955bf3c00f28900339))

## 0.75.0 (2026-02-17)

Full Changelog: [sdk-v0.74.0...sdk-v0.75.0](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.74.0...sdk-v0.75.0)

### Features

* **api:** Releasing claude-sonnet-4-6 ([d75e1c0](https://github.com/anthropics/anthropic-sdk-typescript/commit/d75e1c07bf8c1082610c6493eaa2864a9c042ae8))

