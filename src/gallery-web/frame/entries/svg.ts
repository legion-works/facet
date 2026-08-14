import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { createRendererRegistry } from "../renderers/registry";
import { renderSvgDocument } from "../renderers/svg";

const registry = createRendererRegistry([["svg", renderSvgDocument]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
