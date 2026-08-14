import "../../../gallery-web/frame/styles/artifact.css";
import { renderHtml } from "../../../gallery-web/frame/renderers/html";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["html", renderHtml]]));
