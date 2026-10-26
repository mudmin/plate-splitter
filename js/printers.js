// Printable bed area (X x Y, mm) for common printers. Use "Custom" for anything else.
export const PRINTERS = [
  { group: 'Elegoo', items: [
    ['Neptune 3', 220, 220],
    ['Neptune 3 Pro', 225, 225],
    ['Neptune 3 Plus', 320, 320],
    ['Neptune 3 Max', 420, 420],
    ['Neptune 4 / 4 Pro', 225, 225],
    ['Neptune 4 Plus', 320, 320],
    ['Neptune 4 Max', 420, 420],
    ['Centauri Carbon', 256, 256],
  ] },
  { group: 'Bambu Lab', items: [
    ['A1 mini', 180, 180],
    ['A1', 256, 256],
    ['P1P / P1S / X1C', 256, 256],
    ['H2D', 325, 320],
  ] },
  { group: 'Prusa', items: [
    ['MINI+', 180, 180],
    ['MK3S+ / MK4 / MK4S', 250, 210],
    ['CORE One', 250, 220],
    ['XL', 360, 360],
  ] },
  { group: 'Creality', items: [
    ['Ender 3 / V2 / Pro / S1', 220, 220],
    ['Ender 3 V3 / SE / KE', 220, 220],
    ['Ender 3 S1 Plus / V3 Plus', 300, 300],
    ['Ender 5 S1', 220, 220],
    ['K1 / K1C', 220, 220],
    ['K1 Max', 300, 300],
    ['K2 Plus', 350, 350],
    ['CR-10', 300, 300],
  ] },
  { group: 'Anycubic', items: [
    ['Kobra 2 / Neo / Pro', 220, 220],
    ['Kobra 3', 250, 250],
    ['Kobra 2 Plus', 320, 320],
    ['Kobra 2 Max', 420, 420],
  ] },
  { group: 'Other', items: [
    ['Sovol SV06', 220, 220],
    ['Sovol SV06 Plus', 300, 300],
    ['Sovol SV08', 350, 350],
    ['Qidi Q1 Pro', 245, 245],
    ['Voron 250', 250, 250],
    ['Voron 300', 300, 300],
    ['Voron 350', 350, 350],
  ] },
];

export const DEFAULT_PRINTER = 'Elegoo / Neptune 3';

export function findPrinter(id) {
  for (const g of PRINTERS) for (const [name, w, h] of g.items) {
    if (`${g.group} / ${name}` === id) return { id, w, h };
  }
  return null;
}
