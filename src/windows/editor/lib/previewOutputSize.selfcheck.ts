import { previewOutputSize } from './previewOutputSize.ts';
function assert(ok: boolean, message: string) { if (!ok) throw new Error(message); }
const portrait=previewOutputSize(1080,1920,270,480,1);
assert(portrait.width===270 && portrait.height===480, 'small preview does not rasterize full export frame');
const retina=previewOutputSize(1080,1920,270,480,2);
assert(retina.width===405 && retina.height===720, 'retina preview has bounded pixel density');
const large=previewOutputSize(3840,2160,3840,2160,2);
assert(large.width===1280 && large.height===720, '4K preview stays within raster budget');
const hidden=previewOutputSize(1080,1920,0,0,1);
assert(hidden.height===1280 && hidden.width>0,'unmeasured host has a safe aspect-correct initial size');
assert(Math.abs(portrait.width/portrait.height-1080/1920)<1e-9,'stage aspect and geometry are preserved');
console.log('previewOutputSize.selfcheck: ok');
