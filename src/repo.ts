/**
 * Acceso a archivos: fixtures (solo lectura) y out/ (escritura).
 *
 * Todas las rutas se resuelven desde la raíz del proyecto, nunca absolutas,
 * según el contrato de herramientas del PRD (ctx.directory).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(__dirname, "..");

export const FIXTURES = path.join(RAIZ, "fixtures", "reto-03");

export function rutaOut(...partes: string[]): string {
  return path.join(RAIZ, "out", ...partes);
}

export function escribirOut(rutaRelativa: string, contenido: string): string {
  const destino = rutaOut(rutaRelativa);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, contenido, "utf-8");
  return path.relative(RAIZ, destino).replace(/\\/g, "/");
}

export function agregarLinea(rutaRelativa: string, linea: string): void {
  const destino = rutaOut(rutaRelativa);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.appendFileSync(destino, linea + "\n", "utf-8");
}

/** Limpia out/ al inicio, para garantizar determinismo (PRD 8). */
export function limpiarOut(): void {
  const dir = rutaOut();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/* ---------------- Lectura de fixtures ---------------- */

export function leerMaestro(nombre: string): any[] {
  const ruta = path.join(FIXTURES, "maestros", `${nombre}.json`);
  try {
    return JSON.parse(fs.readFileSync(ruta, "utf-8"));
  } catch {
    return [];
  }
}

export function listarCasos(): string[] {
  const dir = path.join(FIXTURES, "solicitudes");
  try {
    return fs
      .readdirSync(dir)
      .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

export function leerArchivoCaso(caso: string, archivo: string): string | null {
  try {
    return fs.readFileSync(path.join(FIXTURES, "solicitudes", caso, archivo), "utf-8");
  } catch {
    return null;
  }
}

export function leerJsonCaso(caso: string, archivo: string): any | null {
  const texto = leerArchivoCaso(caso, archivo);
  if (texto === null) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}
