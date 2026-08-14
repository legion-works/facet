import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import "../styles/html-vendored.css";
import { renderTsx } from "../renderers/tsx";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["tsx", renderTsx]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
