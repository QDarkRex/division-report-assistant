import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { workStreams } from "../db/schema.ts";

/**
 * One-off — NOT part of the running app. Seeds the 18 work streams of ADR-0016
 * (the registry found by reading the reports of 2026-10-23..2026-11-20).
 * Idempotent: a stream that already exists (even if an admin renamed it) is
 * left untouched. Dry run by default; pass --apply to write.
 *
 * Usage: node dist/scripts/seed-work-streams-20261123.js [--apply]
 */

export interface StreamSeed {
  streamId: string;
  name: string;
  shortName: string; // <= 28 chars
  description: string;
}

export const WORK_STREAM_SEEDS: readonly StreamSeed[] = [
  { streamId: "adm-box-truck", name: "Aerolift Drone Mobil – Box Kontroler & Box Power Truck/Docking", shortName: "ADM Box Truck", description: "Box kontroler dan box power Truck/docking aerolift drone mobil: wiring, konektor aviation, PCB, program motor/lifter/proximity, demo Alpha." },
  { streamId: "adm-kabel-roofrack", name: "Aerolift Drone Mobil – Kabel Konektor 1/2 & Roofrack", shortName: "ADM Kabel & Roofrack", description: "Kabel konektor 1 dan 2, snake cable, braided sleeve, roofrack mobil 1 dan 2." },
  { streamId: "bms-custom", name: "BMS Custom – desain & prototipe (BQ76930/BQ76952)", shortName: "BMS Custom", description: "Desain dan prototipe BMS sendiri: BQ76930/BQ76952, 4S baru, 16S ke 6S, balancing, sleep-wake, I2C ke mikrokontroler." },
  { streamId: "bms-drone-kestrel", name: "BMS Drone Kestrel 4S v1 – solder & uji batch pertama", shortName: "BMS Drone Kestrel 4S", description: "Solder, troubleshooting, dan uji PCB BMS 4S v1 untuk baterai drone Kestrel (batch pertama)." },
  { streamId: "drone-kestrel-docking", name: "Drone Kestrel & Docking Eksisting – uji terbang, battery, firmware", shortName: "Drone Kestrel & Docking", description: "Drone Kestrel dan docking yang sudah ada: uji terbang, pelatihan drone, battery, firmware, CAN, charging." },
  { streamId: "orion-aerolift", name: "Aerolift Drone Orion – box, PSU 400V, pemulihan pasca-crash", shortName: "Aerolift Orion", description: "Aerolift drone Orion: box, PSU 400V, servo AC/CAN bus, pemulihan setelah crash." },
  { streamId: "face-door", name: "Kamera Face-Recognition & Kunci Pintu Lab", shortName: "Face-Recognition & Pintu", description: "Face recognition (kamera, mapping, latensi, Orange Pi) dan kunci pintu lab berbasis ESP32 (W5500, relay, web controller)." },
  { streamId: "enviro-pantau", name: "Sensor Enviro & Aplikasi PANTAU", shortName: "Enviro & PANTAU", description: "Sensor Enviro, box monitoring, dashboard dan aplikasi PANTAU, pemasangan lapangan (Palu, Semarang), pelatihan dan demo." },
  { streamId: "mlink", name: "Radio mlink – uji suara, video RTSP, GPS", shortName: "Radio mlink", description: "Radio mlink: uji suara, streaming video RTSP, GPS, jarak jangkau." },
  { streamId: "sigma-gamma", name: "Project Sigma / Gamma – integrasi & manual book", shortName: "Sigma & Gamma", description: "Project Sigma dan Gamma: integrasi modul, pengujian, manual book, antena." },
  { streamId: "project-tau", name: "Project Tau – receiver, antena, RFQ vendor", shortName: "Project Tau", description: "Project Tau: receiver, antena, permintaan penawaran vendor." },
  { streamId: "pulsar", name: "Pulsar / Epsilon / Produk Pipeline 2027 (+BMS Pulsar)", shortName: "Pulsar & Epsilon", description: "Pulsar, Epsilon, produk pipeline 2027, termasuk PCB dan BMS Pulsar." },
  { streamId: "smart-gate", name: "Smart Gate – prototype & skema kiosk/conveyor", shortName: "Smart Gate", description: "Prototype Smart Gate: skema kiosk dan conveyor, layout, sensor, antena." },
  { streamId: "antenna-tracker", name: "Antenna Tracker v2 & Dome HM", shortName: "Antenna Tracker & Dome", description: "Antenna tracker v2 dan dome HM: PCB controller, bracket, mekanik." },
  { streamId: "controller-panel-cutoff", name: "Controller Panel, CC/CV Buck, Cutoff Baterai & GPS LoRa", shortName: "Controller Panel & Cutoff", description: "PCB controller panel, CC/CV buck regulator, cutoff baterai dengan relay dan INA219, GPS LoRa, LattePanda." },
  { streamId: "pengadaan-inventaris", name: "Pengadaan, Inventaris & Data Komponen", shortName: "Pengadaan & Inventaris", description: "Pembelian dan pengambilan barang, inventaris, sortir komponen, data komponen." },
  { streamId: "pembelajaran-riset", name: "Pembelajaran, Solder Station & Riset Kecil", shortName: "Pembelajaran & Riset", description: "Belajar (computer vision, MQTT, dll.), solder station, riset kecil." },
  { streamId: "lain-lain", name: "Lain-lain / Dukungan Umum (belum terkelompok)", shortName: "Lain-lain", description: "Dukungan umum dan pekerjaan yang tidak cocok dengan aliran lain." },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    const existing = new Set((await db.select({ id: workStreams.streamId }).from(workStreams)).map((r) => r.id));
    const missing = WORK_STREAM_SEEDS.filter((s) => !existing.has(s.streamId));
    console.log(`${WORK_STREAM_SEEDS.length} aliran di seed, ${existing.size} sudah ada, ${missing.length} akan ditambahkan:`);
    for (const s of missing) console.log(`  + ${s.streamId} — ${s.name}`);
    if (!apply) {
      console.log("dry run: tidak ada yang ditulis (pakai --apply)");
      return;
    }
    if (missing.length > 0) {
      await db.insert(workStreams).values(missing.map((s) => ({ ...s, origin: "seed" }))).onConflictDoNothing();
    }
    console.log(`selesai: ${missing.length} ditambahkan`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((error) => {
    console.error("SEED_WORK_STREAMS_ERROR:", error);
    process.exit(1);
  });
}
