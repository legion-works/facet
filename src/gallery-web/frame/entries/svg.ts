import { installGalleryFrameApi } from "../runtime";
import { createRendererRegistry } from "../renderers/registry";
import { renderSvgDocument } from "../renderers/svg";

const registry = createRendererRegistry([["svg", renderSvgDocument]]);
installGalleryFrameApi(registry);
