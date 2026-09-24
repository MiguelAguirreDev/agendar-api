const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { initializeApp, cert } = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  console.log('[INIT] FIREBASE_SERVICE_ACCOUNT:', sa ? `presente (${sa.length} chars)` : 'NO CONFIGURADO');
  if (sa) {
    const cred = JSON.parse(sa);
    console.log('[INIT] Service account project_id:', cred.project_id);
    initializeApp({ credential: cert(cred) });
    db = getFirestore();
    console.log('[INIT] ✅ Firestore iniciado correctamente');
  } else {
    console.log('[INIT] ❌ FIREBASE_SERVICE_ACCOUNT no configurado, Firestore no disponible');
  }
} catch (e) {
  console.error('[INIT] ❌ Error iniciando Firestore:', e.message, e.stack);
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, req.body ? Object.keys(req.body) : '');
  next();
});

const FERIADOS = [
  { mes: '01', dia: '01', nombre: 'Año Nuevo' },
  { mes: '05', dia: '01', nombre: 'Día del Trabajador' },
  { mes: '08', dia: '25', nombre: 'Declaratoria de la Independencia' },
  { mes: '12', dia: '25', nombre: 'Navidad' },
];

async function autoBloquearFeriados() {
  if (!db) return;
  try {
    const year = new Date().getFullYear();
    // clean duplicates from previous buggy runs
    const todas = await db.collection('bloqueos').where('fecha', '>=', `${year}-01-01`).where('fecha', '<=', `${year}-12-31`).get();
    const seen = {};
    const toDelete = [];
    todas.forEach(doc => {
      const d = doc.data();
      if (!d.motivo || !d.motivo.startsWith('Feriado:')) return;
      const key = d.fecha;
      if (seen[key]) toDelete.push(doc.id);
      else seen[key] = doc.id;
    });
    for (const id of toDelete) await db.collection('bloqueos').doc(id).delete();
    if (toDelete.length) console.log(`Eliminados ${toDelete.length} feriados duplicados`);

    for (const f of FERIADOS) {
      const fecha = `${year}-${f.mes}-${f.dia}`;
      const snap = await db.collection('bloqueos').where('fecha', '==', fecha).where('motivo', '==', `Feriado: ${f.nombre}`).get();
      if (snap.empty) {
        await db.collection('bloqueos').add({ fecha, inicio: '', fin: '', motivo: `Feriado: ${f.nombre}`, createdAt: FieldValue.serverTimestamp() });
        console.log(`Feriado bloqueado: ${fecha} (${f.nombre})`);
      }
    }
  } catch (e) {
    console.log('Error auto-bloquear feriados:', e.message);
  }
}
setTimeout(autoBloquearFeriados, 3000);

async function enviarRecordatorios() {
  if (!db || !process.env.RESEND_API_KEY) return;
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fecha = manana.toISOString().slice(0, 10);
    const snap = await db.collection('citas').where('fecha', '==', fecha).get();
    let count = 0;
    snap.forEach(doc => {
      const d = doc.data();
      if (!d.email || d.recordatorioEnviado) return;
      const estadosNoRecordar = ['cancelada', 'completada', 'noasistio'];
      if (estadosNoRecordar.includes(d.estado)) return;
      const fe = new Date(`${d.fecha}T${d.hora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
      resend.emails.send({
        from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
        to: d.email,
        subject: 'Recordatorio de cita - Clínica del Pie Isabel Aguiar',
        html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#0b5345">Recordatorio de cita</h2><p>Hola ${d.paciente}, te recordamos tu cita:</p><p><strong>Fecha y hora:</strong> ${fe}</p><p><strong>Dirección:</strong> Galería — Montevideo</p><p style="color:#64748b;font-size:0.85rem">Si necesitas cancelar o reprogramar, comunicate al teléfono de la clínica.</p></div>`,
      }).then(() => doc.ref.update({ recordatorioEnviado: true }).catch(() => {}))
        .catch(e => console.log('Error recordatorio email:', e.message));
      count++;
    });
    if (count > 0) console.log(`Recordatorios enviados para ${fecha}: ${count}`);
  } catch (e) {
    console.log('Error enviar recordatorios:', e.message);
  }
}
setTimeout(enviarRecordatorios, 5000);
setInterval(enviarRecordatorios, 86400000); // cada 24h

const resend = new Resend(process.env.RESEND_API_KEY);

const hoy = () => new Date().toISOString().slice(0, 10);

function requireDb(req, res) {
  if (!db) return res.status(503).json({ success: false, error: 'Firestore no disponible' });
  return null;
}

app.get(['/', '/ping', '/api/ping'], (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ========== OCUPADOS ==========
app.get(['/ocupados', '/api/ocupados', '/db/ocupados', '/api/db/ocupados'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Falta ?fecha=YYYY-MM-DD' });
    const snap = await db.collection('citas').where('fecha', '==', fecha).get();
    const ocupados = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.estado !== 'cancelada') {
        ocupados.push({ inicio: `${fecha}T${d.hora}:00`, fin: `${fecha}T${d.hora_fin}:00` });
      }
    });
    const snapBloqueos = await db.collection('bloqueos').where('fecha', '==', fecha).get();
    snapBloqueos.forEach(doc => {
      const d = doc.data();
      if (d.inicio && d.fin) {
        ocupados.push({ inicio: `${fecha}T${d.inicio}:00`, fin: `${fecha}T${d.fin}:00` });
      } else {
        ocupados.push({ inicio: `${fecha}T00:00:00`, fin: `${fecha}T23:59:00` });
      }
    });
    res.json({ ocupados });
  } catch (e) {
    console.error('Error ocupados:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== AGENDAR (público) ==========
app.post(['/agendar', '/api/agendar', '/db/agendar', '/api/db/agendar'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { paciente, telefono, email, fecha, hora } = req.body;
    if (!paciente || !telefono || !fecha || !hora) return res.status(400).json({ error: 'Faltan datos' });
    const [hh, mm] = hora.split(':');
    const totalMin = parseInt(hh) * 60 + parseInt(mm) + 45;
    const hhFin = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const mmFin = String(totalMin % 60).padStart(2, '0');
    const docRef = await db.collection('citas').add({
      paciente, telefono, email: email || '', fecha, hora, hora_fin: `${hhFin}:${mmFin}`,
      estado: 'pendiente', notas: '', createdAt: FieldValue.serverTimestamp(),
    });

    const fechaHora = new Date(`${fecha}T${hora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });

    if (process.env.RESEND_API_KEY) {
      if (email) {
        resend.emails.send({
          from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
          to: email,
          subject: 'Cita confirmada - Clínica del Pie Isabel Aguiar',
          html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#0b5345">¡Cita confirmada!</h2><p>Hola, tu cita fue agendada correctamente.</p><p><strong>Fecha y hora:</strong> ${fechaHora}</p><p><strong>Dirección:</strong> Galería — Montevideo</p><p style="color:#64748b;font-size:0.85rem">Si necesitas cancelar o reprogramar, comunicate al teléfono de la clínica.</p></div>`,
        }).catch(e => console.log('Error email paciente:', e.message));
      }
      resend.emails.send({
        from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
        to: process.env.GMAIL_USER,
        subject: `Nueva cita agendada - ${paciente}`,
        html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#0b5345">Nueva cita agendada</h2><p><strong>Paciente:</strong> ${paciente}</p><p><strong>Teléfono:</strong> ${telefono}</p><p><strong>Email:</strong> ${email || '-'}</p><p><strong>Fecha y hora:</strong> ${fechaHora}</p><p><a href="https://clinicadelpieisabelaguiar.web.app/admin.html" style="color:#1a9e8e">Ver panel admin</a></p></div>`,
      }).catch(e => console.log('Error email isabel:', e.message));
    }

    // ===== PUSH NOTIFICATION A ADMINS =====
    console.log('[PUSH] Iniciando envío de notificaciones push a admins...');
    if (db) {
      try {
        const messaging = getMessaging();
        console.log('[PUSH] Firebase Messaging inicializado');
        const tokensSnap = await db.collection('adminTokens').get();
        console.log(`[PUSH] Documentos en adminTokens: ${tokensSnap.size}`);
        const tokens = tokensSnap.docs.map(doc => {
          const data = doc.data();
          console.log(`[PUSH] Token encontrado:`, { user: data.user, tokenPreview: data.token?.substring(0, 20) + '...' });
          return data.token;
        }).filter(Boolean);
        
        if (tokens.length > 0) {
          // --- Paso 1: Eliminar duplicados por usuario (mismo email) ---
          // Agrupamos por user y quedamos con el primer token de cada usuario
          const uniqueTokens = [];
          const seenUsers = new Set();
          for (const doc of tokensSnap.docs) {
            const data = doc.data();
            const user = data.user || 'anónimo';
            if (!seenUsers.has(user)) {
              seenUsers.add(user);
              uniqueTokens.push(data.token);
            }
          }
          console.log('[PUSH] Tokens únicos por usuario:', uniqueTokens.length, 'de', tokens.length);
          
          // Limpiamos duplicados: por usuario, conservamos el token más reciente
          try {
            const grouped = {};
            tokensSnap.docs.forEach(doc => {
              const data = doc.data();
              const user = data.user || 'anónimo';
              if (!grouped[user]) grouped[user] = [];
              grouped[user].push({ id: doc.id, token: data.token, createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : (data.createdAt || 0), updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : (data.updatedAt || 0) });
            });
            for (const user of Object.keys(grouped)) {
              if (grouped[user].length > 1) {
                grouped[user].sort((a,b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
                const toDelete = grouped[user].slice(1);
                console.log('[PUSH] Eliminando duplicados para usuario:', user, toDelete.length);
                for (const d of toDelete) {
                  await db.collection('adminTokens').doc(d.id).delete().catch(()=>{});
                }
                // actualizar grouped[user] para que solo quede el más reciente
                grouped[user] = [grouped[user][0]];
              }
            }
          } catch (err) { console.log('[PUSH] ⚠️ No se pudieron limpiar duplicados:', err.message); }
          
          // Re-colectar tokens únicos después de limpieza (uno por usuario, el más reciente)
          const snapFresh = await db.collection('adminTokens').get();
          const latestByUser = new Map();
          snapFresh.docs.forEach(doc => {
            const data = doc.data();
            const user = data.user || 'anónimo';
            const ts = data.updatedAt?.toMillis ? data.updatedAt.toMillis() : (data.updatedAt || data.createdAt?.toMillis ? data.createdAt.toMillis() : 0);
            const existing = latestByUser.get(user);
            const existingTs = existing?.ts || 0;
            if (!existing || ts > existingTs) {
              latestByUser.set(user, { token: data.token, ts });
            }
          });
          const finalTokens = Array.from(latestByUser.values()).map(v => v.token);
          console.log('[PUSH] Enviando multicast a', finalTokens.length, 'token(s) únicos...');
          
          const response = await messaging.sendEachForMulticast({
            tokens: finalTokens,
            data: {
              citaId: docRef.id,
              tipo: 'nueva_cita',
              fecha,
              hora,
              title: '🔔 Nueva cita agendada',
              body: `${paciente} - ${fechaHora}`
            }
          });
          console.log('[PUSH] Respuesta FCM:', {
            successCount: response.successCount,
            failureCount: response.failureCount,
            responses: response.responses.map((r, i) => ({
              token: finalTokens[i]?.substring(0, 10) + '...',
              success: r.success,
              error: r.error?.message,
              errorCode: r.error?.code
            }))
          });
          if (response.failureCount > 0) {
            const invalidTokens = [];
            response.responses.forEach((r, i) => {
              if (!r.success && (r.error?.code === 'messaging/invalid-registration-token' || r.error?.code === 'messaging/registration-token-not-registered')) {
                invalidTokens.push(finalTokens[i]);
              }
            });
            if (invalidTokens.length > 0) {
              console.log('[PUSH] Eliminando tokens inválidos/expirados:', invalidTokens.length);
              for (const token of invalidTokens) {
                await db.collection('adminTokens').doc(token).delete().catch(() => {});
              }
            }
          }
          console.log(`[PUSH] ✅ Push FCM enviada a ${response.successCount} admin(s), ${response.failureCount} fallaron`);
        } else {
          console.log('[PUSH] ⚠️ No hay tokens registrados en adminTokens');
        }
      } catch (e) {
        console.error('[PUSH] ❌ Error push FCM admin:', e.message, e.stack);
      }
    } else {
      console.log('[PUSH] ❌ db es null, no se puede enviar push');
    }

    res.json({ success: true, id: docRef.id });
  } catch (e) {
    console.error('Error agendar:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== ADMIN: listar citas ==========
app.get(['/admin/citas', '/api/admin/citas', '/db/admin/citas', '/api/db/admin/citas'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const snap = await db.collection('citas').get();
    const citas = [];
    snap.forEach(doc => {
      const d = doc.data();
      citas.push({ id: doc.id, ...d, createdAt: d.createdAt ? d.createdAt.toMillis() : null });
    });
    citas.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora));
    res.json({ success: true, citas });
  } catch (e) {
    console.error('Error listar citas:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== ADMIN: actualizar cita (estado, notas, reagendar) ==========
app.put(['/admin/citas/:id', '/api/admin/citas/:id', '/db/admin/citas/:id', '/api/db/admin/citas/:id'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const docRef = db.collection('citas').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Cita no encontrada' });
    const data = doc.data();

    // Firebase Auth email for cancel notification
    const emailAdmin = req.headers['x-admin-email'] || '';

    // Handle description-based updates (from admin.html parsing)
    if (req.body.description) {
      const desc = req.body.description;
      const estadoMatch = desc.match(/Estado:\s*(.+)/);
      const notasMatch = desc.match(/Notas:\s*(.+)/);
      const pacienteMatch = desc.match(/Paciente:\s*(.+)/);
      const telefonoMatch = desc.match(/Teléfono:\s*(.+)/);
      const emailMatch = desc.match(/Email:\s*(.+)/);

      const updates = {};
      if (estadoMatch) updates.estado = estadoMatch[1].trim();
      if (notasMatch) updates.notas = notasMatch[1].trim();
      if (pacienteMatch) updates.paciente = pacienteMatch[1].trim();
      if (telefonoMatch) updates.telefono = telefonoMatch[1].trim();
      if (emailMatch) updates.email = emailMatch[1].trim();

      if (Object.keys(updates).length > 0) {
        await docRef.update(updates);

        if (estadoMatch && estadoMatch[1].trim() === 'cancelada') {
          const feVieja = new Date(`${data.fecha}T${data.hora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
          const nomPac = data.paciente || 'Paciente';
          const emailPac = data.email || '';
          if (process.env.RESEND_API_KEY) {
            if (emailPac) {
              resend.emails.send({
                from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
                to: emailPac,
                subject: 'Cita cancelada - Clínica del Pie Isabel Aguiar',
                html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#991b1b">Cita cancelada</h2><p>Hola ${nomPac}, tu cita del <strong>${feVieja}</strong> fue cancelada.</p><p>Si querés agendar un nuevo turno, podés hacerlo desde nuestra web.</p><p style="color:#64748b;font-size:0.85rem">Clínica del Pie Isabel Aguiar</p></div>`,
              }).catch(e => console.log('Error email cancel paciente:', e.message));
            }
            resend.emails.send({
              from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
              to: process.env.GMAIL_USER,
              subject: `Cita cancelada - ${nomPac}`,
              html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#991b1b">Cita cancelada</h2><p><strong>Paciente:</strong> ${nomPac}</p><p><strong>Email:</strong> ${emailPac}</p><p><strong>Fecha:</strong> ${feVieja}</p><p><a href="https://clinicadelpieisabelaguiar.web.app/admin.html" style="color:#1a9e8e">Ver panel admin</a></p></div>`,
            }).catch(e => console.log('Error email isabel cancel:', e.message));
          }
        }
      }

      res.json({ success: true });
      return;
    }

    // Handle direct field updates (reagendar: fecha + hora)
    if (req.body.start) {
      const start = new Date(req.body.start.dateTime);
      const end = new Date(req.body.end.dateTime);
      const nuevaFecha = start.toISOString().slice(0, 10);
      const nuevaHora = start.toTimeString().slice(0, 5);
      const horaFin = end.toTimeString().slice(0, 5);

      await docRef.update({ fecha: nuevaFecha, hora: nuevaHora, hora_fin: horaFin });

      const feVieja = new Date(`${data.fecha}T${data.hora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
      const feNueva = new Date(`${nuevaFecha}T${nuevaHora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
      const nomPac = data.paciente || 'Paciente';
      const emailPac = data.email || '';

      if (process.env.RESEND_API_KEY) {
        if (emailPac) {
          resend.emails.send({
            from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
            to: emailPac,
            subject: 'Cita reagendada - Clínica del Pie Isabel Aguiar',
            html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#0b5345">Cita reagendada</h2><p>Hola ${nomPac}, tu cita fue reprogramada.</p><p><strong>Anterior:</strong> ${feVieja}</p><p><strong>Nueva fecha y hora:</strong> ${feNueva}</p><p><strong>Dirección:</strong> Galería — Montevideo</p><p style="color:#64748b;font-size:0.85rem">Si necesitas cancelar o reprogramar, comunicate al teléfono de la clínica.</p></div>`,
          }).catch(e => console.log('Error email reagendar paciente:', e.message));
        }
        resend.emails.send({
          from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
          to: process.env.GMAIL_USER,
          subject: `Cita reagendada - ${nomPac}`,
          html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#0b5345">Cita reagendada</h2><p><strong>Paciente:</strong> ${nomPac}</p><p><strong>Email:</strong> ${emailPac}</p><p><strong>Anterior:</strong> ${feVieja}</p><p><strong>Nueva:</strong> ${feNueva}</p><p><a href="https://clinicadelpieisabelaguiar.web.app/admin.html" style="color:#1a9e8e">Ver panel admin</a></p></div>`,
        }).catch(e => console.log('Error email isabel reagendar:', e.message));
      }

      res.json({ success: true });
      return;
    }

    // Direct field updates
    await docRef.update(req.body);

    if (req.body.estado === 'cancelada') {
      const feVieja = new Date(`${data.fecha}T${data.hora}:00`).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
      const nomPac = data.paciente || 'Paciente';
      const emailPac = data.email || '';
      if (process.env.RESEND_API_KEY) {
        if (emailPac) {
          resend.emails.send({
            from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
            to: emailPac,
            subject: 'Cita cancelada - Clínica del Pie Isabel Aguiar',
            html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#991b1b">Cita cancelada</h2><p>Hola ${nomPac}, tu cita del <strong>${feVieja}</strong> fue cancelada.</p><p>Si querés agendar un nuevo turno, podés hacerlo desde nuestra web.</p><p style="color:#64748b;font-size:0.85rem">Clínica del Pie Isabel Aguiar</p></div>`,
          }).catch(e => console.log('Error email cancel paciente:', e.message));
        }
        resend.emails.send({
          from: 'Clinica del Pie Isabel Aguiar <onboarding@resend.dev>',
          to: process.env.GMAIL_USER,
          subject: `Cita cancelada - ${nomPac}`,
          html: `<div style="font-family:sans-serif;max-width:600px"><h2 style="color:#991b1b">Cita cancelada</h2><p><strong>Paciente:</strong> ${nomPac}</p><p><strong>Email:</strong> ${emailPac}</p><p><strong>Fecha:</strong> ${feVieja}</p><p><a href="https://clinicadelpieisabelaguiar.web.app/admin.html" style="color:#1a9e8e">Ver panel admin</a></p></div>`,
        }).catch(e => console.log('Error email isabel cancel:', e.message));
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Error update cita:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== ADMIN: eliminar cita ==========
app.delete(['/admin/citas/:id', '/api/admin/citas/:id', '/db/admin/citas/:id', '/api/db/admin/citas/:id'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    await db.collection('citas').doc(req.params.id).delete();
    res.json({ success: true, message: 'Cita eliminada' });
  } catch (e) {
    console.error('Error delete cita:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== BLOQUEOS ==========
app.post(['/admin/bloquear', '/api/admin/bloquear', '/db/admin/bloquear', '/api/db/admin/bloquear'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { fecha, inicio, fin, motivo } = req.body;
    await db.collection('bloqueos').add({
      fecha, inicio: inicio || '', fin: fin || '', motivo: motivo || 'Bloqueado',
      createdAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Error bloquear:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get(['/admin/bloqueados', '/api/admin/bloqueados', '/db/admin/bloqueados', '/api/db/admin/bloqueados'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const snap = await db.collection('bloqueos').orderBy('fecha', 'asc').get();
    const bloqueos = [];
    snap.forEach(doc => bloqueos.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, bloqueos });
  } catch (e) {
    console.error('Error listar bloqueos:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete(['/admin/bloquear/:id', '/api/admin/bloquear/:id', '/db/admin/bloquear/:id', '/api/db/admin/bloquear/:id'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    await db.collection('bloqueos').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error('Error eliminar bloqueo:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== TRATAMIENTOS ==========
app.get(['/admin/tratamientos', '/api/admin/tratamientos'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const snap = await db.collection('tratamientos').orderBy('nombre', 'asc').get();
    const trat = [];
    snap.forEach(doc => trat.push({ id: doc.id, ...doc.data() }));
    res.json({ success: true, tratamientos: trat });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post(['/admin/tratamientos', '/api/admin/tratamientos'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { nombre, monto } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
    const docRef = await db.collection('tratamientos').add({ nombre: nombre.trim(), monto: parseFloat(monto) || 0, createdAt: FieldValue.serverTimestamp() });
    res.json({ success: true, id: docRef.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put(['/admin/tratamientos/:id', '/api/admin/tratamientos/:id'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { nombre, monto } = req.body;
    const updates = {};
    if (nombre !== undefined) updates.nombre = nombre.trim();
    if (monto !== undefined) updates.monto = parseFloat(monto);
    await db.collection('tratamientos').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete(['/admin/tratamientos/:id', '/api/admin/tratamientos/:id'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    await db.collection('tratamientos').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ========== PUSH NOTIFICATIONS ENDPOINTS ==========

// Registrar token FCM desde frontend (alternativa a guardar directo en Firestore)
app.post(['/api/push/register-token', '/push/register-token'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { token, user, userAgent } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Falta token' });
    // Guardar nuevo token
    await db.collection('adminTokens').doc(token).set({
      token,
      user: user || 'unknown',
      userAgent: userAgent || '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    // Eliminar tokens obsoletos del mismo usuario (reinstalación -> token nuevo reemplaza al viejo)
    if (user) {
      try {
        const snap = await db.collection('adminTokens').where('user', '==', user).get();
        const toDelete = [];
        snap.forEach(doc => {
          if (doc.id !== token) toDelete.push(doc.id);
        });
        for (const id of toDelete) {
          await db.collection('adminTokens').doc(id).delete().catch(()=>{});
        }
        if (toDelete.length) console.log(`[PUSH/REGISTER] Eliminados ${toDelete.length} tokens antiguos de ${user}`);
      } catch (e) { console.log('[PUSH/REGISTER] No se pudieron limpiar tokens antiguos:', e.message); }
    }
    console.log('[PUSH/REGISTER] Token guardado:', { user, tokenPreview: token.substring(0, 20) + '...' });
    res.json({ success: true });
  } catch (e) {
    console.error('[PUSH/REGISTER] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test push manual desde backend
app.post(['/api/push/test', '/push/test'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const { token, title, body } = req.body;
    const messaging = getMessaging();
    
    let targetTokens = [];
    if (token) {
      targetTokens = [token];
    } else {
      const tokensSnap = await db.collection('adminTokens').get();
      targetTokens = tokensSnap.docs.map(doc => doc.data().token).filter(Boolean);
    }
    
    if (targetTokens.length === 0) {
      return res.json({ success: false, error: 'No hay tokens registrados' });
    }
    
    console.log('[PUSH/TEST] Enviando test a', targetTokens.length, 'token(s)');
    const response = await messaging.sendEachForMulticast({
      tokens: targetTokens,
      notification: { title: title || 'Test Push', body: body || 'Prueba desde backend' },
      data: { tipo: 'test', timestamp: Date.now().toString() }
    });
    
    console.log('[PUSH/TEST] Resultado:', { successCount: response.successCount, failureCount: response.failureCount });
    res.json({ success: true, sent: response.successCount, failed: response.failureCount });
  } catch (e) {
    console.error('[PUSH/TEST] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Ver estado de tokens registrados
app.get(['/api/push/tokens', '/push/tokens'], async (req, res) => {
  if (requireDb(req, res)) return;
  try {
    const snap = await db.collection('adminTokens').get();
    const tokens = snap.docs.map(doc => {
      const data = doc.data();
      return {
        token: data.token.substring(0, 20) + '...',
        user: data.user,
        userAgent: data.userAgent,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : data.createdAt,
        updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : data.updatedAt
      };
    });
    res.json({ success: true, count: tokens.length, tokens });
  } catch (e) {
    console.error('[PUSH/TOKENS] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Health check con info de push
app.get(['/api/push/status', '/push/status'], async (req, res) => {
  const messaging = db ? getMessaging() : null;
  res.json({
    status: 'ok',
    firestore: !!db,
    messaging: !!messaging,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Servidor corriendo en el puerto ${PORT}`));