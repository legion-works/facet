import { renderHtmlStub } from "../../../gallery-web/frame/renderers/html-stub";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["html", renderHtmlStub]]));
