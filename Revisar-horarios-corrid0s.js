/**
 * Diagnostico de citas con hora corrida +3h (bug de reagendado).
 *
 * QUE HACE: SOLO LEE y lista. No modifica nada.
 *   node Revisar-horarios-corrid0s.js         -> lista en pantalla
 *   node Revisar-horarios-corrid0s.js --json  -> salida JSON
 *
 * POR QUE HAY DOS NIVELES DE SOSPECHA
 *   El bug guardaba la hora en UTC, dejando la cita +3h. Pero una cita correcta
 *   de 15:00 es indistinguible de una corrida si no hay mas senal, asi que el
 *   script NO adivina: separa lo que puede afirmarse de lo que no.
 *
 *   corrupta  -> prueba objetiva: fuera de horario, duracion != 45 min, o el
 *                horario corregido ya esta OCUPADO por otra cita (colision).
 *                Si aparece en esta lista, casi seguro hay que corregirla.
 *   sospecha  - > la cita es valida en si, pero restarle 3h tambien daria un
 *                horario valido. No se puede afirmar sola: revisala a mano.
 *   revisar   -> datos incompletos.
 *   ok        -> correcta.
 */

const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* dotenv opcional */ }

const { initializeApp, cert } = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const TZ = 'America/Montevideo';
const OFFSET_HORAS = 3;            // Uruguay UTC-3
const DURACION_MIN = 45;           // duracion de cada cita
const HORARIO = { inicio: 9, fin: 17, paso: 15 };

function slotsValidos() {
  const out = new Set();
  for (let h = HORARIO.inicio; h <= HORARIO.fin; h++) {
    for (let m = 0; m < 60; m += HORARIO.paso) {
      if (h === HORARIO.fin && m > 0) continue;
      out.add(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
}
const SLOTS = slotsValidos();

function aMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function aHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Cuenta cuantas citas vivas (no canceladas) ocupan cada fecha+hora
function indiceOcupacion(citas) {
  const map = new Map();
  for (const c of citas) {
    if (!c.fecha || !c.hora || c.estado === 'cancelada') continue;
    const k = `${c.fecha} ${c.hora}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return map;
}

function analizar(c, ocupacion) {
  const r = {
    id: c.id, fecha: c.fecha, hora: c.hora, hora_fin: c.hora_fin,
    paciente: c.paciente || '', telefono: c.telefono || '',
    estado: c.estado || '', reagendada: !!c.reagendada,
    veredicto: 'ok', detalle: '', hora_corregida: null
  };

  if (!c.fecha || !c.hora) {
    r.veredicto = 'revisar';
    r.detalle = 'sin fecha/hora';
    return r;
  }

  // (1) duracion rota: el bug nunca la alteraba, asi que es senal objetiva
  if (c.hora_fin) {
    const dur = aMin(c.hora_fin) - aMin(c.hora);
    if (dur !== DURACION_MIN) {
      r.veredicto = 'corrupta';
      r.detalle = `duracion ${dur} min (esperado ${DURACION_MIN})`;
      return r;
    }
  }

  const enHorario = SLOTS.has(c.hora);
  const corrida = aHHMM(aMin(c.hora) - OFFSET_HORAS * 60);

  // (2) fuera del horario de la clinica
  if (!enHorario) {
    const corregida = SLOTS.has(corrida);
    r.hora_corregida = corregida ? corrida : null;
    r.veredicto = corregida ? 'corrupta' : 'corrupta';
    r.detalle = corregida
      ? `fuera de horario, posible +${OFFSET_HORAS}h -> deberia ser ${corrida}`
      : `hora "${c.hora}" fuera de ${HORARIO.inicio}:00-${HORARIO.fin}:00`;
    return r;
  }

  // (3) COLISION: el horario corregido ya esta tomado por otra cita viva.
  //     Senal fuerte: la persona ya tiene turno ahi, esta es la que se corrio.
  const clave = `${c.fecha} ${corrida}`;
  const otras = (ocupacion.get(clave) || []).filter(o => o.id !== c.id && o.estado !== 'cancelada');
  if (corrida !== c.hora && SLOTS.has(corrida) && otras.length > 0) {
    r.hora_corregida = corrida;
    r.veredicto = 'corrupta';
    r.detalle = `colision: ${corrida} ya esta ocupado por ${otras[0].paciente || 'otra cita'} -> posible +${OFFSET_HORAS}h`;
    return r;
  }

  // (4) ambigua: ambas horas son plausibles. Se usa la senal de auditoria.
  if (corrida !== c.hora && SLOTS.has(corrida) &&
      aMin(c.hora) >= HORARIO.inicio * 60 + OFFSET_HORAS * 60) {
    r.hora_corregida = corrida;
    if (c.reagendada) {
      // Solo las citas reagendadas son candidatas: las del publico nunca
      // pasaron por el bug, asi que una cita publica nunca se "corrige".
      r.veredicto = 'corrupta';
      r.detalle = `reagendada y ${corrida} tambien seria valido: casi seguro +${OFFSET_HORAS}h`;
    } else {
      r.veredicto = 'sospecha';
      r.detalle = `agendada por el publico (no fue reagendada): ${corrida} no aplica`;
    }
    return r;
  }

  return r;
}

async function main() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT en el entorno / .env');
    process.exit(1);
  }
  initializeApp({ credential: cert(JSON.parse(sa)) });
  const db = getFirestore();

  const snap = await db.collection('citas').get();
  const citas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const ocupacion = indiceOcupacion(citas);
  const res = citas.map(c => analizar(c, ocupacion));

  const g = v => res.filter(r => r.veredicto === v);
  const [corruptas, sospecha, revisar, ok] = [g('corrupta'), g('sospecha'), g('revisar'), g('ok')];

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(
      { total: res.length, ok: ok.length, corruptas, sospecha, revisar }, null, 2));
    return;
  }

  console.log(`\n=== Revision de horarios (offset ${OFFSET_HORAS}h, duracion ${DURACION_MIN} min) ===`);
  console.log(`Total: ${res.length} | ok: ${ok.length} | CORRUPTA: ${corruptas.length} | ` +
              `sospecha: ${sospecha.length} | revisar: ${revisar.length}\n`);

  const tabla = (arr) => arr.map(r => ({
    fecha: r.fecha, hora: r.hora, deberia: r.hora_corregida || '-',
    fin: r.hora_fin, paciente: r.paciente, tel: r.telefono, motivo: r.detalle
  }));

  if (corruptas.length) {
    console.log('--- CORRUPTAS (casi seguro hay que corregir) ---');
    console.table(tabla(corruptas));
  }
  if (sospecha.length) {
    console.log('--- SOSPECHOSAS (revisar a mano: son ambiguas) ---');
    console.table(tabla(sospecha));
  }
  if (revisar.length) {
    console.log('--- A REVISAR (datos incompletos) ---');
    console.table(revisar.map(r => ({ fecha: r.fecha, hora: r.hora, paciente: r.paciente, motivo: r.detalle })));
  }
  if (!corruptas.length && !sospecha.length && !revisar.length) {
    console.log('Todo en orden: no se detectaron anomalias.\n');
  }
  console.log('Este script NO modifico nada. Nada fue escrito en Firestore.\n');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });