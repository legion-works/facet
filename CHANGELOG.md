# Changelog

## [1.8.0](https://github.com/legion-works/facet/compare/v1.7.1...v1.8.0) (2026-08-24)


### Features

* **cli:** facet doctor environment diagnostics ([aef2b03](https://github.com/legion-works/facet/commit/aef2b03a3fa6aed6367806fbd171977dd7c90481))
* **cli:** publish --watch continuous republishing ([6de4dba](https://github.com/legion-works/facet/commit/6de4dba0b5e3c28a3c4d8e7b789336c2f9c20058))
* **mcp:** stdio adapter exposing the CLI contract as MCP tools ([f7de87c](https://github.com/legion-works/facet/commit/f7de87ce0bab0593b0ba1670b9ebff1d16297817))


### Bug Fixes

* **cli:** harden doctor contract ([1890aca](https://github.com/legion-works/facet/commit/1890acac5f4521980be854cfde809e0b81dada26))
* **cli:** make doctor repair commands runnable ([ca6cff2](https://github.com/legion-works/facet/commit/ca6cff2214931fbebfa5c2155fcd41141625a47b))
* **cli:** stabilize watch retries and failures ([7364b11](https://github.com/legion-works/facet/commit/7364b112093ff6482104b52694d012d2f57c8c83))
* **mcp:** document inline publish contract ([68daf5a](https://github.com/legion-works/facet/commit/68daf5a26a869e2977760d361ec2401891128505))
* **mcp:** map schema errors to Facet envelopes ([4743edf](https://github.com/legion-works/facet/commit/4743edf2bac87b4d2726e8d76005256069ff1e82))
* **mcp:** restrict adapter imports to wire contracts ([f4cb644](https://github.com/legion-works/facet/commit/f4cb644b6f043e65034038de5736c5e861498e5a))
* **runtime:** preserve source entrypoint laziness ([fb2a248](https://github.com/legion-works/facet/commit/fb2a24837569d5fdeb788f64df17291d4c6faebb))
* **service:** reap pooled workers on idle-driven stop ([517a6c2](https://github.com/legion-works/facet/commit/517a6c2cdf619b546f607daf82ce5754593c2ed6))

## [1.7.1](https://github.com/legion-works/facet/compare/v1.7.0...v1.7.1) (2026-08-23)


### Bug Fixes

* **export:** bind sidecar filename to the exported file — closes [#20](https://github.com/legion-works/facet/issues/20) ([149857c](https://github.com/legion-works/facet/commit/149857c6f98ca31abed2f7c469c5650484f53801))
* **gallery:** keep lease cleanup off bootstrap path ([c99ea55](https://github.com/legion-works/facet/commit/c99ea55a026d82afc86f75fed23d7db9fcc039de))
* **gallery:** replace persisted session for bootstrap ([c97ae12](https://github.com/legion-works/facet/commit/c97ae12755cbadbf423216c9c1db5cac0b348e84))
* **open:** report launch state and default latest revision ([a4db90d](https://github.com/legion-works/facet/commit/a4db90df93b17d18fd6674e86bc6451aa79f03c4))
* **tier1:** embed gallery frame chrome styles ([cffc371](https://github.com/legion-works/facet/commit/cffc371919a07aa8705ded3614b5ad3f472c7115))
* **version:** derive release version from package ([43d611c](https://github.com/legion-works/facet/commit/43d611cea51501c5a8618466ddeea566352c525a))

## [1.7.0](https://github.com/legion-works/facet/compare/v1.6.0...v1.7.0) (2026-08-23)


### Features

* **evidence:** PNG/WebP image contract + v9 screenshot_format migration ([5a9637f](https://github.com/legion-works/facet/commit/5a9637fbc5b4c02904b499e155cb2657371c2f3e))
* **export:** format-aware evidence serving + WebP-aware export surfaces ([79ef7e4](https://github.com/legion-works/facet/commit/79ef7e4e217fe7e5e519d002b646b4d8f7255ad8))
* **export:** shared export primitives; artifact-titled gallery tab ([b91be67](https://github.com/legion-works/facet/commit/b91be67f7de090f2c68e21a8284b085d87eb4ea3))
* **gallery:** browser export menu — source, render, sidecar ([fdfa931](https://github.com/legion-works/facet/commit/fdfa93180b794e33a042d67f3b2087bf226afede))
* **gallery:** center artifacts with safe overflow and a readable measure ([0d6408c](https://github.com/legion-works/facet/commit/0d6408c21d28045854671fee40c4181121f4e5de))
* **gallery:** confine embedded diagram pan/zoom to its region ([a6e123e](https://github.com/legion-works/facet/commit/a6e123e755d434d8558aff3e6a151954b7f22cea))
* **gallery:** dark/light/system theme control with expiry-safe rerender ([f93ab34](https://github.com/legion-works/facet/commit/f93ab34d28fd6c4f919f7c25e04e586c99f2dcdb))
* **gallery:** resolved-theme threading through frames and renderers ([634acf1](https://github.com/legion-works/facet/commit/634acf1fa97b3cf1fa5c8532fdc4be348d6a7f93))
* **gallery:** semantic color variables + dual-theme vendored styles ([2836f25](https://github.com/legion-works/facet/commit/2836f25680d2465c18f6b59cee0796f254c1bd0b))
* **gallery:** verdict-tinted dynamic favicon ([ae82550](https://github.com/legion-works/facet/commit/ae825509ba82abd412feabeed1ead2fae9948789))
* **service:** lease-gated gallery evidence route ([4e245e4](https://github.com/legion-works/facet/commit/4e245e45858181a563fbc9b4ce9efa0518b4b039))
* **templates:** add complex artifact examples ([ca85bfb](https://github.com/legion-works/facet/commit/ca85bfb04695dbb7f7ce41acbee823f6d37987eb))
* **templates:** add SVG and HTML examples ([4de821c](https://github.com/legion-works/facet/commit/4de821ca3cdff61fbc9bab6d689792ad51ba3c73))
* **templates:** facet-story interactive TSX — the dev-process showcase ([cb00f29](https://github.com/legion-works/facet/commit/cb00f295f1493d23893a26989a1f7d485acc4b30))
* **tier1:** animated WebP evidence for declared animation ([e41fab1](https://github.com/legion-works/facet/commit/e41fab18ec50c2a047560fdd6337124b38e1d4b1))
* **tier1:** whole-artifact static WebP evidence capture ([6045ac9](https://github.com/legion-works/facet/commit/6045ac9e1937091a9f98a3d57c8ca7ad325c4d71))


### Bug Fixes

* **auth:** serialize empty token recovery ([bf1a8e6](https://github.com/legion-works/facet/commit/bf1a8e610ddba7952c16e7eaa971e886cca45a90))
* **boundaries:** accept CRLF continuations ([40819ae](https://github.com/legion-works/facet/commit/40819ae46d3ca5e60fafaa21a07c4a7a2c8c0d78))
* **boundaries:** fail closed on backtick dynamic import specifiers ([8e01c74](https://github.com/legion-works/facet/commit/8e01c7453c8279a210665a068a6237670c1c31a7))
* **boundaries:** lex imports without string confusion ([8968f65](https://github.com/legion-works/facet/commit/8968f658583999622ccb575e33a978b8eb378b14))
* **boundaries:** scan whole-file text so a multiline dynamic import cannot bypass the guard ([8b9c351](https://github.com/legion-works/facet/commit/8b9c35132ecfc188c3d1cb65479b40840971ce2b))
* Bun 1.4.0 runtime compatibility — formatter, TSX evidence, stress ([71d7410](https://github.com/legion-works/facet/commit/71d7410e26438970377f81643dbc71627270d5ae))
* **ci:** host-independent mermaid viewBox assertions; empty-diff skip in changed-test-stress ([387336c](https://github.com/legion-works/facet/commit/387336c44cc72ee176b0c7fb367f3675c3484bc6))
* **cli:** allow piped publish without file flag ([6dc6483](https://github.com/legion-works/facet/commit/6dc6483ba11aa2cada7a6216f191a4b89ff6214b))
* **cli:** reclaim dead foreign locks ([85a6058](https://github.com/legion-works/facet/commit/85a60580edbff59b64e6111e801a5b9acdf187bf))
* **cli:** recover revisions and project file exports ([bcebd27](https://github.com/legion-works/facet/commit/bcebd270344763b67402e3b4eb1335935b81cfde))
* **cli:** reject invalid metadata formats ([83a0e6f](https://github.com/legion-works/facet/commit/83a0e6f477f20145fcee0d64e028179e142c413a))
* **evidence:** require screenshot format in stored runs ([f96674b](https://github.com/legion-works/facet/commit/f96674badb96c153c1d073ab803921d2e62fae77))
* **export:** reject unsniffable evidence bytes ([09352e7](https://github.com/legion-works/facet/commit/09352e751532b0e6f1a84ae33b15a4be8e45e227))
* **frame:** validate before latching render ([a5a8b3c](https://github.com/legion-works/facet/commit/a5a8b3cd523dfb6019d46efd808c8feff3df3608))
* **gallery:** allow inline styles in the artifact frame CSP ([d85273a](https://github.com/legion-works/facet/commit/d85273a628b3bf7436178321c83d465c861464ae))
* **gallery:** bug-hunt fix wave ([aa6778f](https://github.com/legion-works/facet/commit/aa6778ff5b85856e36b72974f180cf618aa8d554))
* **gallery:** close semantic color audit ([dffe8a6](https://github.com/legion-works/facet/commit/dffe8a6305bca87d28183e46176ddb85009442e6))
* **gallery:** close the stale-export window during evidence fetch ([472f13d](https://github.com/legion-works/facet/commit/472f13d9d5ead1919eab3e18a65ef38e46d61975))
* **gallery:** converge drift from the teardown arc ([ed6bf04](https://github.com/legion-works/facet/commit/ed6bf046607e6aa64735e3230cf6e841cb52a91e))
* **gallery:** cover viewBox-less svg zoom; comment cleanup ([79e8430](https://github.com/legion-works/facet/commit/79e8430d3341bd5929ab9fb9115b996815335fae))
* **gallery:** CSP on root fallback, branch lease-expiry close, suppress panzoom on all siblings ([af08b85](https://github.com/legion-works/facet/commit/af08b856b9715241b943d121279be4e25f3bddd0))
* **gallery:** deliver TSX execution to initial frame ([0500702](https://github.com/legion-works/facet/commit/05007023e5d407407de5ddfff54f9a2731bb21c5))
* **gallery:** expire terminal sessions safely ([a58c50e](https://github.com/legion-works/facet/commit/a58c50e3bbc8fc08cf839f6fd765cca6e8a315fa))
* **gallery:** gate in-flight swap completion on terminal expiry ([fbc2043](https://github.com/legion-works/facet/commit/fbc2043cf3f253b5b43d95d8ca3d43bfa6c64f1c))
* **gallery:** install/remove wheel+pointer listeners only in panzoom mode ([c4e4d18](https://github.com/legion-works/facet/commit/c4e4d18667c398d318f01078693b18b5cf9305c1))
* **gallery:** keep failed swaps theme-consistent ([bbc71b0](https://github.com/legion-works/facet/commit/bbc71b043b483a8bc126098e9debc3b64b257f76))
* **gallery:** keep mermaid labels in markdown fences ([0159b89](https://github.com/legion-works/facet/commit/0159b890551814046d129b3f1347eec60c7ae166))
* **gallery:** keep zoom and pan in the frame document ([2a16e28](https://github.com/legion-works/facet/commit/2a16e288958cf52e5053ae549c2c30afb078873d))
* **gallery:** legible worker-card contrast in the night theme ([b0a58d1](https://github.com/legion-works/facet/commit/b0a58d15098ad39b547aae6d14a39a1bb1caae76))
* **gallery:** native scroll by default; pan/zoom toggle for documents, on by default for diagrams ([21d112f](https://github.com/legion-works/facet/commit/21d112f1788dcad6f622acbe08cef8b1a93172d6))
* **gallery:** pan scrolls the container instead of moving the viewBox camera ([d57a7db](https://github.com/legion-works/facet/commit/d57a7db46cc87f1a865141f7b0931fb490fd3869))
* **gallery:** preserve terminal shell state ([eee5586](https://github.com/legion-works/facet/commit/eee5586ba7d7ea5875093beecfcb0681d9fd6a2b))
* **gallery:** preserve TSX source bytes in export; typed evidence 404; extract export menu ([a06a44e](https://github.com/legion-works/facet/commit/a06a44ef2b36bb9135768adc205218fe6399453a))
* **gallery:** preserve visible artifact bounds ([9620afa](https://github.com/legion-works/facet/commit/9620afa371f09150c4e3b97561ef570a4c6be221))
* **gallery:** refresh survives without re-issuing the bootstrap token ([f12d804](https://github.com/legion-works/facet/commit/f12d804867480954d87e593c6b16910618e5cf50))
* **gallery:** render wide mermaid at natural size instead of squeezing to fit ([b3173fd](https://github.com/legion-works/facet/commit/b3173fdc8c122a2a9c22e79ad2f11b57d9310756))
* **gallery:** restore artifact scrolling ([1892853](https://github.com/legion-works/facet/commit/1892853b3bb5659c41b79fc5b41677aba75aa434))
* **gallery:** retain theme intent across revision swaps ([049cc35](https://github.com/legion-works/facet/commit/049cc352df4b86c9c5ba8464b53b412317683113))
* **gallery:** serialize theme and revision swaps ([925dc39](https://github.com/legion-works/facet/commit/925dc390b88dc1a3ac46149e8184fbcb671eec7c))
* **gallery:** single-region engagement exclusivity + discriminating pins ([ffd435f](https://github.com/legion-works/facet/commit/ffd435f98f71a329f699b1b8d169ba6618758095))
* **gallery:** source resolved shell theme ([ee222c8](https://github.com/legion-works/facet/commit/ee222c8a4a01cdd3e2c25b1286f514ce7c724051))
* **gallery:** style nested interactive TSX frames ([869cd8c](https://github.com/legion-works/facet/commit/869cd8c69cd83534b08ac08df7a8af8142f5064d))
* **gallery:** the stage is the window — remove the inset artifact card ([782d5aa](https://github.com/legion-works/facet/commit/782d5aa1d12e8e003140a260e5f8bec8d4936c4f))
* **gallery:** use dark vendored HTML theme ([d1a92c8](https://github.com/legion-works/facet/commit/d1a92c84b898c1771fed3258073689f48bf72be5))
* **gallery:** vendor full daisyUI styles ([f2bb14f](https://github.com/legion-works/facet/commit/f2bb14f14206fa19f7ab384ecc93a3f1f6e05037))
* **lifecycle,tier1,cli:** fail-closed orphan cleanup, remove stranded late-launch profile, reject verb-scoped --format ([e23e867](https://github.com/legion-works/facet/commit/e23e867fa81cde222ad060b7a3516f60b27be466))
* **mermaid:** count composite state nodes by scope ([cf22c09](https://github.com/legion-works/facet/commit/cf22c099877527ae87fb49b5b7b4cf593e8b295f))
* **mermaid:** match Tier 1 node counts ([b5831fd](https://github.com/legion-works/facet/commit/b5831fd8893d38ea340ee7404fea01fae4c0f235))
* **paths:** thread the evidence root end-to-end; tolerate legacy XDG root ([6453eda](https://github.com/legion-works/facet/commit/6453eda6d56e2bdcecbb6497f12a0420366286f0))
* **runtime:** enforce caps at wire boundaries ([43dc8fd](https://github.com/legion-works/facet/commit/43dc8fd275252ec9170aa12abb496caaa4bf2672))
* **runtime:** tighten protocol and gesture guards ([caaf3fb](https://github.com/legion-works/facet/commit/caaf3fb50dad960369b6d1ec0595939545b9dffa))
* **service:** converge SSE teardown; fire lease-release listeners ([3a2ad84](https://github.com/legion-works/facet/commit/3a2ad8484da081059293a307980ec1346347a24a))
* **service:** keep SSE sockets alive through heartbeats ([c72177d](https://github.com/legion-works/facet/commit/c72177deb215dd5de17df52c14a4eb2b12a75329))
* **service:** preserve evidence and build root shell ([2196508](https://github.com/legion-works/facet/commit/2196508283fac5747f31b87a4046412f0a94c85d))
* **service:** renew leases from SSE heartbeats ([0acdd76](https://github.com/legion-works/facet/commit/0acdd7663e1d39a62e68c97846719a97b94cdae1))
* **service:** return stored publish verdicts ([4bd41b9](https://github.com/legion-works/facet/commit/4bd41b9332451a8b2fb567b87124a14b0ee0c554))
* **store:** reject cross-artifact promotion; validate render-run before insert ([437591f](https://github.com/legion-works/facet/commit/437591fbec5c4bbef0b9ce96a03865bd4c1a8abc))
* **store:** serialize evidence ownership cleanup ([11b8e1b](https://github.com/legion-works/facet/commit/11b8e1bfed464bd280c5c4a3099e3af9ea6e11f1))
* **template:** align story metrics and taxonomy ([72c9bcb](https://github.com/legion-works/facet/commit/72c9bcbf5dc0ff001bfba5d83e67026f042de205))
* **tests:** isolate DOM shim from gallery globals ([b16220b](https://github.com/legion-works/facet/commit/b16220b46e45f2c1f340966c5cf984284975b4a6))
* **tier1:** preserve interactive animated evidence ([44da439](https://github.com/legion-works/facet/commit/44da439d8ca9612ae6769d7ed4a5ed405fbd8867))
* **tier1:** scale whole-artifact WebP capture ([8ab5106](https://github.com/legion-works/facet/commit/8ab510637c0540d2ece922d8f5398bbbf1a40fb6))
* **tier1:** size the Markdown verifier frame ([1b6b146](https://github.com/legion-works/facet/commit/1b6b14684243b5c7cbdc3f58fd870b1b631035b0))
* **tier1:** wait for browser exit before profile reuse ([9af867e](https://github.com/legion-works/facet/commit/9af867e472bddc28f44c9cebeb7ab1ffe7cae221))
* **tokens:** create install token exclusively ([5f16202](https://github.com/legion-works/facet/commit/5f16202cae39072ae6fb3771d3f2b0b63021e404))
* **tsx:** render starters with the Legion dark style vocabulary ([f863588](https://github.com/legion-works/facet/commit/f86358882e7f0cc6d0244a07307180bd21c37636))
* **validation:** run Tier 1 on visual read-back ([46ae18f](https://github.com/legion-works/facet/commit/46ae18f8dceb6ce7eb5142ad070233ac3ab5177f))


### Performance Improvements

* **tsx:** select production React bundles ([37fd6c5](https://github.com/legion-works/facet/commit/37fd6c5845c9890eec0799fc5ad84d3706798947))

## [1.6.0](https://github.com/legion-works/facet/compare/v1.5.0...v1.6.0) (2026-08-13)


### Features

* add tsx execution verdicts and unstable status ([9925901](https://github.com/legion-works/facet/commit/992590147095ef43728fdd1ba1f1b29478e30e87))
* compile TSX in tier 0 ([265252b](https://github.com/legion-works/facet/commit/265252b0a1ca7789caeb2377dc18b549124c3295))
* implement the tsx artifact type contract ([8088267](https://github.com/legion-works/facet/commit/80882679f3503cb09ead5ca1e626933d19cd8f80))
* render tsx in isolated frames ([b23d39b](https://github.com/legion-works/facet/commit/b23d39b979e5d619477c09d7aa18755d60362990))
* **tsx:** verify interactive nested frames ([b7f0d40](https://github.com/legion-works/facet/commit/b7f0d40a247936db6ea114bad7ee6f392ce1ca67))


### Bug Fixes

* derive the execution enum from one canonical source (DRIFT 2.1, 2.2, 2.3) ([10f2b62](https://github.com/legion-works/facet/commit/10f2b62b8bd5c36318ccb82fbec52165ad3dbe23))
* **gallery:** accept canonical render counts ([8af3ac0](https://github.com/legion-works/facet/commit/8af3ac0784821ebab7624741d7d2a329f693f79a))
* harden the tsx stub and the FK gate per review (Must 1 + 2 + Should 1 + 2) ([36393a1](https://github.com/legion-works/facet/commit/36393a1fa5741f2569c498a4a406198a785b9fd7))
* isolate nested-frame egress acceptance spawn ([97a3f52](https://github.com/legion-works/facet/commit/97a3f52ccb9cf408a33a990ce8227188dd75ebef))
* preserve TSX compile failures in tier 0 ([53b3719](https://github.com/legion-works/facet/commit/53b3719fcdb1e02377c14609255d5efd6082de15))
* propagate execution mode when instantiating a template (DRIFT 1.2) ([4b5c733](https://github.com/legion-works/facet/commit/4b5c733b475f36fb4e0d1f3c222c4cf6250339b8))
* route read-back through verdictFromStoredRun and pin the execution-null policy ([632db68](https://github.com/legion-works/facet/commit/632db688cbc556ce86d143cc1eae8fc84c2b5802))
* stop the CLI client from silently dropping verdict fields (Must 2) ([0e3894d](https://github.com/legion-works/facet/commit/0e3894d238ad3982ac77e9610c6f425cbb1906eb))
* surface every observed field and execution through the acceptance harness ([ce67729](https://github.com/legion-works/facet/commit/ce67729b0569fefa410fbcd6ab77e243ba79fdba))
* **tsx:** authenticate nested frame handshakes ([5a83675](https://github.com/legion-works/facet/commit/5a8367590101b9c3f354ceffce41e002449e7c53))
* **tsx:** block Tier 1 after compile errors ([48f1264](https://github.com/legion-works/facet/commit/48f126425a2d388f59b5f3b7d976047bc093ed3a))
* **tsx:** isolate concurrent compiler workspaces ([819b4bb](https://github.com/legion-works/facet/commit/819b4bb6283fed6f79893f23464607f07329a2b4))
* **tsx:** stabilize compiled bundle bytes ([6860f6b](https://github.com/legion-works/facet/commit/6860f6b622272cb3e9ee9822c52d7de31736c09c))
* **tsx:** strip frame handshake secret ([84e633d](https://github.com/legion-works/facet/commit/84e633db73355d60f6c47ce0e570440abc6e71bb))
* **tsx:** surface interactive runtime failures ([01e7b73](https://github.com/legion-works/facet/commit/01e7b733d5b84a040420d05631cca135c0e1a04d))


### Performance Improvements

* **tsx:** fix AST bypasses, add compile-time allowlist resolver, mark latency PROVISIONAL-PENDING-NETNS ([c18c517](https://github.com/legion-works/facet/commit/c18c517cb321dbfa7427efaf1aa759d1e7c955fe))
* **tsx:** measure compiler cost and adopt Bun.build ([eefab5f](https://github.com/legion-works/facet/commit/eefab5f1689403a77abbdad4a03facf58dd84c15))
* **tsx:** simplify AST policy per D13a and fix scope-walker false rejections ([9200179](https://github.com/legion-works/facet/commit/920017905e0402358ccaa01a2a802a4bf99e74bf))

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
