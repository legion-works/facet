import { startGalleryFrame } from "../bootstrap";
import { renderHtmlStub } from "../renderers/html-stub";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["html", renderHtmlStub]]));
