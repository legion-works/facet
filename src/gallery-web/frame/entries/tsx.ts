import { startGalleryFrame } from "../bootstrap";
import { renderTsx } from "../renderers/tsx";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["tsx", renderTsx]]));
