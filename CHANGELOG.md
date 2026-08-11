# Changelog

## [1.5.0](https://github.com/legion-works/facet/compare/v1.4.0...v1.5.0) (2026-08-11)


### Features

* add html observables and the external-resource status ([072bfa7](https://github.com/legion-works/facet/commit/072bfa749c506d07fdd77439b2ff930e9466fe4d))
* implement the html artifact type contract ([56c52af](https://github.com/legion-works/facet/commit/56c52af8cc1401f7e851cd85b3df8a00075439d5))
* observe and verdict html structure in tier 1 ([b0cc2fa](https://github.com/legion-works/facet/commit/b0cc2fa807c1777152b6c5fe114dfef29502bd70))
* parse static html in tier 0 ([e54323b](https://github.com/legion-works/facet/commit/e54323b55a4c7e885f527dfbeee437f0d1851e66))
* permit external https images in the frozen csp ([29d000e](https://github.com/legion-works/facet/commit/29d000ed634b37511887feb39be3af55d0eae7e4))
* render html in a frame-owned root with vendored styling ([061c68b](https://github.com/legion-works/facet/commit/061c68ba222782e17cd37f165d90743293408fb3))


### Bug Fixes

* bound html nesting depth ([6171bbf](https://github.com/legion-works/facet/commit/6171bbfe7e40fc7a809869139add61c8fd4ce88c))
* close template and url scheme policy bypasses ([d5a3d6a](https://github.com/legion-works/facet/commit/d5a3d6a47953317ee7437994e079a5a2b4c1885d))
* count external references in every markdown container ([e7f4c89](https://github.com/legion-works/facet/commit/e7f4c89776ea8c6ecd69256bb7ba5b1e2e1b993c))
* couple the differential corpus to production observation ([05a162f](https://github.com/legion-works/facet/commit/05a162feadedfaac12bc12ef049ba345afcfc7d5))
* detect unsupported select recovery by tokenizing ([ce68832](https://github.com/legion-works/facet/commit/ce6883200c6d18d5fb4356a03d4f55270425970e))
* disclose external references for every artifact type ([e51fb33](https://github.com/legion-works/facet/commit/e51fb331e512c2e28ccf174fa8070864e8e5d619))
* exclude user-agent shadow content from html observation ([04e3267](https://github.com/legion-works/facet/commit/04e3267d9bb5051140f3b076d1a63655594229a0))
* move tier 0 gates to isolated CI and retry EBADF ([f76e968](https://github.com/legion-works/facet/commit/f76e968cc30de5b14b1986f9ab44c6aff6c52f00))
* retain sandbox launch diagnostics ([e7e7de5](https://github.com/legion-works/facet/commit/e7e7de58e009b069e3848cdb1b6016a21f63fbd3))
* scope sandbox env and decouple EBADF unit gate ([39612ca](https://github.com/legion-works/facet/commit/39612cae7822ae27c1fb14d7090f305e61761376))
* treat noscript as parsed markup in the select detector ([e151833](https://github.com/legion-works/facet/commit/e1518336cbc8263e7b98f4a585d915d607bc3a9e))
* type the missing-result worker protocol failure ([200d400](https://github.com/legion-works/facet/commit/200d4001b72fd943c3ba226daacd38aea68e617c))


### Performance Improvements

* pool the tier 0 worker ([abbafd5](https://github.com/legion-works/facet/commit/abbafd54ec37e0ed541f01d051c6b0aeb8d89f54))

## [1.4.0](https://github.com/legion-works/facet/compare/v1.3.0...v1.4.0) (2026-08-10)


### Features

* add the facet export cli verb ([832bf8b](https://github.com/legion-works/facet/commit/832bf8b2209c87fe5b5e416e3a90a2ae0218d267))
* export retained tier 1 screenshot evidence ([d07a2aa](https://github.com/legion-works/facet/commit/d07a2aa9ef1ef0e12378e66fd3a48755a2d2b803))
* export stored source bytes with a verdict sidecar ([60518b2](https://github.com/legion-works/facet/commit/60518b24c83bfd439998a87f3f564470b862d280))
* ratify the export command contract ([3998997](https://github.com/legion-works/facet/commit/39989973b074ee1d4cc75b2814d4b62fa20ce62f))


### Bug Fixes

* correct export transport, confinement, and stale references ([6de663c](https://github.com/legion-works/facet/commit/6de663c57f83a80895e3a75cc35f816b5c01f60b))
* keep export file pairs atomic and sanitize derived names ([183a33c](https://github.com/legion-works/facet/commit/183a33cb6bb7bd6bfeffc9493ebf1dcdbf4e0d15))
* write export pairs atomically ([9513ee5](https://github.com/legion-works/facet/commit/9513ee5272d2302ac819422f7b3872f39c6df230))

## [1.3.0](https://github.com/legion-works/facet/compare/v1.2.0...v1.3.0) (2026-08-10)


### Features

* add insecure dispatcher semantics and wire disclosure ([59b230e](https://github.com/legion-works/facet/commit/59b230e4c97ebd94b16abceea370f05c3553caad))
* add insecure level and status contracts ([4b391e2](https://github.com/legion-works/facet/commit/4b391e27d1b04f53d22c5df7d9b47f2a0a454f9e))
* add opt-in insecure auto fallback ([de411db](https://github.com/legion-works/facet/commit/de411db0c9527700b835c7d614dfd2691d5eb7f0))
* implement insecure sandbox level selection ([ee207cd](https://github.com/legion-works/facet/commit/ee207cd123297817e75537ce0dc321eb7783126b))
* make insecure mode loud on every surface ([2971166](https://github.com/legion-works/facet/commit/297116653fd6f7ff3fa34069653b8eeb0a74cd14))
* persist insecure markers with v5 migration ([1ee2825](https://github.com/legion-works/facet/commit/1ee28252f1e97db16253c2f99d5f03b4a5a99396))
* thread insecure level through service boot ([2afce35](https://github.com/legion-works/facet/commit/2afce3579625015d8ad8e45a4167c6e19595977c))


### Bug Fixes

* gate service stderr inherit on insecure boot ([c13d409](https://github.com/legion-works/facet/commit/c13d40910a10a0fdfd12f30a630d976e9a44c4e3))
* surface insecure marker on gallery source route ([50043d9](https://github.com/legion-works/facet/commit/50043d9114feea6674b2ac2360ddcd809a1b7d80))

## [1.2.0](https://github.com/legion-works/facet/compare/v1.1.0...v1.2.0) (2026-08-10)


### Features

* add opaque renderer contracts ([d284fa3](https://github.com/legion-works/facet/commit/d284fa31e911a8e79d10cd5a0cfcf74ffc0fdb5d))
* cap opaque content verdicts ([99ccb21](https://github.com/legion-works/facet/commit/99ccb21563856a08e9ed0576f8f265746287dfd0))
* derive renderer-aware expectations ([c85acab](https://github.com/legion-works/facet/commit/c85acabd16e87cc13aa2c03c47f1d120ff5a21aa))
* label opaque partial verdicts ([3a40003](https://github.com/legion-works/facet/commit/3a40003cfaae2b00c52afb7dd4c725a3544febee))
* observe opaque render regions ([5bb677c](https://github.com/legion-works/facet/commit/5bb677c4e19d077c9d766139f6df28835e69d196))
* persist revision renderer ([a452e0f](https://github.com/legion-works/facet/commit/a452e0fca1af3fc02c5eb03628ad47977278c7c7))
* render charts with canvas backend ([27f9007](https://github.com/legion-works/facet/commit/27f90076f475ce8101927c3cb07ccbaa4cd12b0a))


### Bug Fixes

* honest verdict when opaque screenshot evidence is transiently unavailable ([1b96f29](https://github.com/legion-works/facet/commit/1b96f293da937d902465861b4d18058d9ec39830))
* null isolated observations and frame-scoped canvas census ([7dcb7a5](https://github.com/legion-works/facet/commit/7dcb7a5a27557b5b23c917657eba88c591cefbec))

## [1.1.0](https://github.com/legion-works/facet/compare/v1.0.0...v1.1.0) (2026-08-09)


### Features

* capture full-artifact tier1 screenshot evidence at a deterministic 1280x800 viewport ([f84c0ca](https://github.com/legion-works/facet/commit/f84c0ca91ab28f224d732317107560ebc3fb3922))
* svg-native viewBox zoom in the gallery frame ([cd83cac](https://github.com/legion-works/facet/commit/cd83caccea0d75aa3332eede949f4d88265fb14d))


### Bug Fixes

* enforce perf budgets by host sensitivity, not browser use ([65e9f96](https://github.com/legion-works/facet/commit/65e9f965762ede6c59d8854c1163b4d582ec19ed))
* keep measured budgets when the browser probe dies ([d48a262](https://github.com/legion-works/facet/commit/d48a2623ae79a2706065a2d9764c64ffe2457e04))
* make the service boundary guard fail closed ([6953ef6](https://github.com/legion-works/facet/commit/6953ef6dcba1222d92c5e1eb26db22b00b75a257))
* pre-decode screenshot cap + raw-event view-mode validation ([634878f](https://github.com/legion-works/facet/commit/634878f4cf6a3f390283465feeab1e8a75abb50c))


### Performance Improvements

* **gallery:** split frame renderer bundles ([af46b64](https://github.com/legion-works/facet/commit/af46b640703657bcd7dddec0c6eed4d7ab064744))

## 1.0.0 (2026-08-09)


### Features

* add audited facet templates ([d32537c](https://github.com/legion-works/facet/commit/d32537c2597e39d57b9dedc0bec8e0b91e51379b))
* add crash-safe artifact store ([8a3d405](https://github.com/legion-works/facet/commit/8a3d405a7af285df1a43e5f3f6c2cd9ea37ca481))
* add default tier zero validation ([9e3a73a](https://github.com/legion-works/facet/commit/9e3a73ac67bdc7962b81df29e4d11df1a29b8f3a))
* add facet cli contract ([47453df](https://github.com/legion-works/facet/commit/47453df3abe72fc8f8b6568da31a9ec9133747c0))
* add lease-gated gallery source route and wire the shell entry point ([e02c16a](https://github.com/legion-works/facet/commit/e02c16a0f40ef0bc79c05b2737b1933dcc595bc2))
* add sandboxed facet gallery shell ([2cdeb69](https://github.com/legion-works/facet/commit/2cdeb6918ac0996996b0068cc73b8cf8a10d27de))
* add secure lazy facet service ([22bbba9](https://github.com/legion-works/facet/commit/22bbba971cc5d4886768d1df2eb097552483d4eb))
* add unfakeable tier one validation ([a225628](https://github.com/legion-works/facet/commit/a225628e79cb57e9ad52e8e4c3c37eddd0c6b537))
* add user-browser gallery display ([8ad5b79](https://github.com/legion-works/facet/commit/8ad5b7969c2633515c8bc4b545e607bdbc7e11a9))
* apply the facet visual identity to the gallery, cli, and templates ([2d32202](https://github.com/legion-works/facet/commit/2d322025fc990b80ba14714c439a349a04e5196b))
* cursor-anchored wheel zoom and drag pan for gallery ([6fb4b6f](https://github.com/legion-works/facet/commit/6fb4b6fdc8ae6d15697b461e9780efcec84104f2))
* define facet v1 contract ([c75f9ef](https://github.com/legion-works/facet/commit/c75f9ef5414d92e243e40d4aba418550d51317f9))
* expose facet health and budgets ([b0f2083](https://github.com/legion-works/facet/commit/b0f20836393ec7507b6374a4b17954c1640301b0))
* persist revision-bound read-back evidence ([5e2967c](https://github.com/legion-works/facet/commit/5e2967c1545dd0b86a41e778857c6708f939d926))
* render structured facet artifacts ([424c34d](https://github.com/legion-works/facet/commit/424c34d7d420f92cce6bbec965db34abeb7424fc))
* wire no-spawn service status to the cli ([4987510](https://github.com/legion-works/facet/commit/49875108aff04989bee41ba7cf29d98c679d991e))


### Bug Fixes

* bind tier1 error verdict to real artifact id ([394a0f3](https://github.com/legion-works/facet/commit/394a0f36c3d6c58b3566b5ca8938062eec4b2c7a))
* **ci:** resolve project formatter explicitly ([2debf25](https://github.com/legion-works/facet/commit/2debf256892915e69341f40e2bddfd6f51106827))
* clean up staged temp files on failed atomic write ([c80a8c7](https://github.com/legion-works/facet/commit/c80a8c71a9647346a35a639f2a007118a0641083))
* declare mermaid dep and cover tier0 stdout guard ([9f7d713](https://github.com/legion-works/facet/commit/9f7d7133bda4d4ee49fab6dad01fc44c05168012))
* do not re-mode pre-existing ancestor directories ([53a54b8](https://github.com/legion-works/facet/commit/53a54b84aa1251dde4f14be897bdd8de0969b572))
* enforce 0700 on per-run evidence dir under hostile umask ([dda8d18](https://github.com/legion-works/facet/commit/dda8d189a3d6d112f559dee919a1915730952412))
* enforce owner-only mode on secret-bearing dirs ([a09ad09](https://github.com/legion-works/facet/commit/a09ad094a378af645cac5366e0b9b77134cbb87d))
* exempt release-generated changelog from the format gate ([6fb842d](https://github.com/legion-works/facet/commit/6fb842d8e243bfb036d2f9dc83b8bd24779653e9))
* harden service auth, locking, and lease lifecycle ([4552825](https://github.com/legion-works/facet/commit/4552825281907c9bcf580afdb4bb44499d6e243a))
* harden store commit path and permissions ([f9058ac](https://github.com/legion-works/facet/commit/f9058ac0f9ea5447be241f85a0f76932cd2426b6))
* launch the gallery probe browser only when the live gate runs ([e3e55c5](https://github.com/legion-works/facet/commit/e3e55c5c5a39ebcf255a61a6ecc69c4d7c6980fc))
* load the frame bootstrap by url so the gallery frame boots ([740c3f0](https://github.com/legion-works/facet/commit/740c3f0a96bed322663cfc8c838291b27edd045c))
* mount the frame before awaiting load and read the nonce from the frame url ([fefe6cd](https://github.com/legion-works/facet/commit/fefe6cd97c73409752e21a675c1705bc5a163953))
* probe netns synchronously and give the tier 0 worker boundary an honest schema ([efdd3b0](https://github.com/legion-works/facet/commit/efdd3b0484cbe5195c3b3c0d88445baf22690f73))
* read PSS from smaps_rollup and stop faking perf passes ([3208811](https://github.com/legion-works/facet/commit/32088114c0b18f1fcfa86abc595fbc1c5440e146))
* reconcile instantiate audit field and eviction candidate rule ([463928a](https://github.com/legion-works/facet/commit/463928a5654073fae2c4479a266a324f52fb67b0))
* remove query-lease acceptance and harden host guard ([ad0a7b7](https://github.com/legion-works/facet/commit/ad0a7b778b06c0569b748ac4c339024e4a62a1ab))
* render legible artifacts — svg text labels, dark theme, csp-safe charts, fit to frame ([728fbf9](https://github.com/legion-works/facet/commit/728fbf9b2956241e8494a07c260c1e7ca444939d))
* resolve service entrypoint absolute so the cli works from any cwd ([bdccc1b](https://github.com/legion-works/facet/commit/bdccc1b2e0ff227e8233307107c82f2d991b5aee))
* bound cli command requests with a typed timeout instead of hanging ([745d52f](https://github.com/legion-works/facet/commit/745d52fa11cfee8d965f17e89a54ce06d1cb256e))
* sanitize CSS url/expression in imported SVG ([1dd9bb3](https://github.com/legion-works/facet/commit/1dd9bb30eeb04e6c7296d414a767a9602405fb4d))
* serve the frame document from a loopback url so the frozen csp applies ([1c22eab](https://github.com/legion-works/facet/commit/1c22eab06509b7bf35b90868b654cd02d59aec26))
* serve the real gallery shell at /gallery (build-on-demand) + route coverage ([519c68e](https://github.com/legion-works/facet/commit/519c68eccef671bcbf407fcf1a651b45f2eb3465))
* stage lock and state temp files in target dir to avoid cross-device rename ([ec20222](https://github.com/legion-works/facet/commit/ec202226cf94b6e63dece2f8e2725ca9b5e78ff1))
* tighten facet v1 contract validation ([3723d50](https://github.com/legion-works/facet/commit/3723d507ec8a2276883d7f819ac8ea262c5aa2a3))
* unblock mermaid tier1 render so acceptance gates pass ([ed4391b](https://github.com/legion-works/facet/commit/ed4391bdd9d2767d80fa1062a80c1d7dd715b7cd))
* use invalid_request for cli input validation errors ([e53b5a0](https://github.com/legion-works/facet/commit/e53b5a0988fed062980c3b0c9c35215215e06b12))
* use umask 0o177 in evidence dir test to actually trigger it ([adba2a0](https://github.com/legion-works/facet/commit/adba2a0f6fe9432f4804eeca8d63cdc268cd8745))
* whitelist url(#fragment) in svg css sanitizer ([6595a1c](https://github.com/legion-works/facet/commit/6595a1c1a27d12501a5ea87988b667547be41072))
