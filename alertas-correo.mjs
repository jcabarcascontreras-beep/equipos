// Correo semanal de alertas de mantenimiento · Clínica La Merced
// Lo ejecuta GitHub cada lunes (archivo .github/workflows/alertas.yml).
// Lee el cronograma de Firebase, arma el resumen de mantenimientos y lo envía por Gmail.

import fs from 'node:fs';
import nodemailer from 'nodemailer';

const PROYECTO = 'equipos-biomedicos-clm';
const API_KEY = 'AIzaSyAC-a5UX-7RYy5ZmZ2vUemR9RiCP_Ylh1o';
const APP_URL = process.env.APP_URL || 'https://jcabarcascontreras-beep.github.io/equipos/sistema.html';
const BASE = process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
const REGISTRO = 'alertas-registro.json';
const SIN_ENVIO = process.env.SIN_ENVIO === '1';

const MESL = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const HOY = new Date(), TODAY = iso(HOY), NOW = { y: HOY.getFullYear(), m: HOY.getMonth() + 1 };
const fmt = s => { if (!s) return '—'; const [y, m, d] = String(s).split('-'); return d ? d + '/' + m + '/' + y : s; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const Cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/* ---------- leer Firebase ---------- */
function dec(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = dec(x); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  return null;
}
async function leer(col) {
  const docs = {}; let token = '';
  do {
    const url = `${BASE}/projects/${PROYECTO}/databases/(default)/documents/${col}?pageSize=100&key=${API_KEY}${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`No se pudo leer "${col}" de Firebase (${r.status}). Revisa que las reglas permitan leer sin iniciar sesión. ${await r.text()}`);
    const j = await r.json();
    for (const d of j.documents || []) docs[d.name.split('/').pop()] = dec({ mapValue: { fields: d.fields || {} } });
    token = j.nextPageToken || '';
  } while (token);
  return docs;
}

/* ---------- misma lógica de la página ---------- */
function calcularPreventivo(prevDocs) {
  const anios = [...new Set(Object.values(prevDocs).map(d => Number(d.anio)).filter(Boolean))].sort((a, b) => a - b);
  const anio = anios.includes(NOW.y) ? NOW.y : anios[anios.length - 1];
  const cmp = m => anio < NOW.y ? -1 : anio > NOW.y ? 1 : m < NOW.m ? -1 : m > NOW.m ? 1 : 0;
  const siguiente = m => (anio === NOW.y && m === NOW.m + 1) || (NOW.m === 12 && anio === NOW.y + 1 && m === 1);
  const rango = it => ({ III: 0, IIB: 1, IIA: 2, I: 3 }[it.riesgo] ?? 4);
  const atr = [], mes = [], prox = [];
  let prog = 0, hech = 0;
  for (const d of Object.values(prevDocs)) {
    if (Number(d.anio) !== anio) continue;
    for (const [id, it0] of Object.entries(d.items || {})) {
      const it = Object.assign({ id, servicio: d.servicio }, it0, { meses: it0.meses || {} });
      if (it.fuera) continue;
      for (let m = 1; m <= 12; m++) {
        const v = it.meses['m' + m]; if (v !== 'P' && v !== 'R') continue;
        const c = cmp(m);
        if (c < 0) { prog++; if (v === 'R') hech++; }
        else if (c === 0 && v === 'R') { prog++; hech++; }
        if (v === 'P') { if (c < 0) atr.push({ it, m }); else if (c === 0) mes.push({ it, m }); else if (siguiente(m)) prox.push({ it, m }); }
      }
    }
  }
  const orden = (a, b) => a.it.servicio.localeCompare(b.it.servicio) || rango(a.it) - rango(b.it) || a.m - b.m;
  atr.sort(orden); mes.sort(orden); prox.sort(orden);
  return { anio, atr, mes, prox, prog, hech, cumplimiento: prog ? Math.round(hech / prog * 100) : null, atraso: m => (NOW.y - anio) * 12 + NOW.m - m };
}
/* ---------- armar el correo (resumido) ---------- */
const URGENTES = 10;
function correo(P) {
  const caja = (n, l, color) => `<td style="padding:10px 12px;border:1px solid #D6E1E1;border-radius:8px;background:#fff;width:25%"><div style="font-size:24px;font-weight:bold;color:${color};line-height:1.1">${n}</div><div style="font-size:12px;color:#566C6E">${l}</div></td>`;
  // conteo por servicio
  const serv = {};
  const sumar = (lista, k) => lista.forEach(({ it }) => { const s = serv[it.servicio] || (serv[it.servicio] = { atr: 0, mes: 0, prox: 0 }); s[k]++; });
  sumar(P.atr, 'atr'); sumar(P.mes, 'mes'); sumar(P.prox, 'prox');
  const filasServ = Object.entries(serv).sort((a, b) => b[1].atr - a[1].atr || b[1].mes - a[1].mes).map(([n, s]) =>
    `<tr><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3">${esc(n)}</td><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3;text-align:center;color:#A12D23;font-weight:bold">${s.atr || '–'}</td><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3;text-align:center">${s.mes || '–'}</td><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3;text-align:center">${s.prox || '–'}</td></tr>`).join('');
  const th = (t, c) => `<th style="padding:6px 8px;font-size:12px;color:#566C6E;border-bottom:1px solid #D6E1E1;text-align:${c ? 'center' : 'left'}">${t}</th>`;
  // los más urgentes: mayor riesgo y más atraso
  const rango = it => ({ III: 0, IIB: 1, IIA: 2, I: 3 }[it.riesgo] ?? 4);
  const urg = P.atr.slice().sort((a, b) => rango(a.it) - rango(b.it) || P.atraso(b.m) - P.atraso(a.m)).slice(0, URGENTES);
  const filasUrg = urg.map(({ it, m }) => { const n = P.atraso(m); return `<tr><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3"><b>${esc(it.eq)}</b>${it.serie && it.serie !== 'N/P' ? ' · ' + esc(it.serie) : ''}<br><span style="color:#566C6E">${esc([it.servicio, it.ubic].filter(Boolean).join(' · '))}</span></td><td style="padding:6px 8px;font-size:13px;border-bottom:1px solid #EEF3F3;text-align:right;white-space:nowrap"><b style="color:#A12D23">${n === 1 ? '1 mes' : n + ' meses'}</b><br><span style="color:#566C6E">${Cap(MESL[m - 1])}</span></td></tr>`; }).join('');
  const hayAlgo = P.atr.length || P.mes.length || P.prox.length;
  return `<!doctype html><html><body style="margin:0;background:#EEF3F3;font-family:Arial,Helvetica,sans-serif;color:#132527">
  <div style="max-width:640px;margin:0 auto;padding:20px">
    <div style="background:#0D2426;color:#fff;border-radius:12px 12px 0 0;padding:16px 20px">
      <div style="font-size:13px;color:#86A9A6">Clínica La Merced · Electromedicina</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px">Alertas de mantenimiento preventivo</div>
      <div style="font-size:13px;color:#D5E7E5;margin-top:4px">Corte al ${fmt(TODAY)}</div>
    </div>
    <div style="background:#F7FAFA;border:1px solid #D6E1E1;border-top:0;border-radius:0 0 12px 12px;padding:16px 20px">
      <table cellpadding="0" cellspacing="6" style="width:100%;border-collapse:separate"><tr>
        ${caja(P.atr.length, 'Atrasados', '#A12D23')}${caja(P.mes.length, 'Toca este mes', '#8A5608')}${caja(P.prox.length, 'Próximo mes', '#8A5608')}${caja(P.cumplimiento == null ? '—' : P.cumplimiento + '%', 'Cumplimiento', '#00675F')}
      </tr></table>
      ${hayAlgo ? `<h2 style="font-size:16px;margin:22px 0 6px">Por servicio</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff"><tr>${th('Servicio')}${th('Atrasados', 1)}${th('Este mes', 1)}${th('Próximo mes', 1)}</tr>${filasServ}</table>` : '<p style="font-size:15px;margin:18px 0 0"><b>Todo al día.</b> No hay mantenimientos atrasados ni pendientes.</p>'}
      ${urg.length ? `<h2 style="font-size:16px;margin:22px 0 6px">Los ${urg.length} más urgentes</h2>
      <p style="font-size:12px;color:#566C6E;margin:0 0 6px">Equipos de mayor riesgo con más tiempo de atraso.</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff">${filasUrg}</table>` : ''}
      <p style="margin:20px 0 0"><a href="${APP_URL}#alertas" style="display:inline-block;background:#00756E;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:8px">Ver la lista completa</a></p>
      <p style="font-size:12px;color:#566C6E;margin-top:22px;border-top:1px solid #D6E1E1;padding-top:10px">Mensaje automático. Se envía cada lunes.</p>
    </div>
  </div></body></html>`;
}

/* ---------- principal ---------- */
const prevDocs = await leer('preventivos');
if (!Object.keys(prevDocs).length) console.log('Aviso: no hay cronograma cargado en Firebase (colección preventivos).');
const P = Object.keys(prevDocs).length ? calcularPreventivo(prevDocs) : { anio: NOW.y, atr: [], mes: [], prox: [], cumplimiento: null, atraso: () => 0 };
const asunto = `Mantenimiento preventivo ${fmt(TODAY)}: ${P.atr.length} atrasados, ${P.mes.length} este mes`;
const html = correo(P);
console.log(asunto);

const destino = (process.env.CORREO_DESTINO || '').split(/[,;\s]+/).filter(Boolean);
if (SIN_ENVIO) {
  fs.writeFileSync('vista-previa-correo.html', html);
  console.log('Modo prueba: no se envió. Vista previa en vista-previa-correo.html');
} else {
  const usuario = process.env.CORREO_USUARIO, clave = (process.env.CORREO_CLAVE || '').replace(/\s+/g, '');
  if (!usuario || !clave || !destino.length) throw new Error('Faltan los secretos CORREO_USUARIO, CORREO_CLAVE o CORREO_DESTINO en GitHub (Settings > Secrets and variables > Actions).');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: usuario, pass: clave } });
  const r = await t.sendMail({ from: `"Alertas Electromedicina CLM" <${usuario}>`, to: destino.join(', '), subject: asunto, html });
  console.log('Correo enviado a', destino.length, 'destinatario(s):', r.messageId);
}

let reg = [];
try { reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8')); if (!Array.isArray(reg)) reg = []; } catch (e) { reg = []; }
reg.push({ fecha: TODAY, hora: pad(HOY.getHours()) + ':' + pad(HOY.getMinutes()), destinatarios: SIN_ENVIO ? 0 : destino.length, atrasados: P.atr.length, esteMes: P.mes.length, proximoMes: P.prox.length, cumplimiento: P.cumplimiento, prueba: SIN_ENVIO || undefined });
fs.writeFileSync(REGISTRO, JSON.stringify(reg.slice(-200), null, 1) + '\n');
