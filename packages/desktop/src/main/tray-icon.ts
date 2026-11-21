import { nativeImage } from "electron";

// A 16 px orbit glyph (1x and 2x), black on transparent: a macOS template image.
const x1 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAlklEQVR4nLVTWw3AIAw8CUhAwiQgZY6QgBQkTAISkLCF5EgKoRt7XdKfXttrSwF+hAHgaOZO4gIgAtg7K75AUwuuDM4AvOjAd8WCplzITVFIVwUilWWypVWBJMZpYEh44QuKYh2n6dLR6YRyv0SrxH5T4PUIM0usQnm0REw8oyG3M3aIs0PK5FYtWXainbKqPMLjz3QLB2O4SWZDsvNHAAAAAElFTkSuQmCC";
const x2 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABJUlEQVR4nO1XAQ2EMAw8CUh4CUhAAhImYRJwgIRJQAISkPASkMA/SSGkGd26QfafcMkSAmvv1nZbAR78KRoA9vvQ0bD07nZSB2AJDEdzXwAMgBZAlUO8Gg8RxNKYAdQp5DUZc4cTrXRLgaN3IRGqSPjIHYX2DOu3tyCijSWvGPmsKLJREGBiBQwZ+esFAVL0djTMSLu9KqEeonw5lvMzbNvMeFZWUSRGVhOSvx0xIfOFuReEHueJOIZ/UpCHREyxabCBcPHVxBbaMa1WEtAdJnae7yZCgG+rhfz+joDiKShehCi9DXHRQZTib0fuUXyJr5zLaAO/zgeNcc51DJrL7dVtWWpDwvvG5HbsTMSiaMmyyDekNqVDbjfMoW3Lb0WRH5MHt+AD/IgeGaJBRw4AAAAASUVORK5CYII=";

export const trayIcon = () => {
  const image = nativeImage.createFromBuffer(Buffer.from(x1, "base64"), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(x2, "base64") });
  image.setTemplateImage(true);
  return image;
};
