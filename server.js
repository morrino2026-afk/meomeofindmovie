// ================================================================
// Backend Node.js (Express) cho "MeoMeoFindMovie"
// - Phục vụ frontend tĩnh trong thư mục /public (index.html, v.v.)
// - Cung cấp API gửi & xác minh mã OTP qua email (thay cho EmailJS trước đây)
// - Firebase (Realtime Database + Authentication) KHÔNG đổi gì — frontend vẫn
//   gọi thẳng Firebase SDK từ trình duyệt như cũ, backend này không đụng vào đó.
//
// HỆ THỐNG PHÒNG VỆ OTP — 4 LỚP:
//   Lớp 1: Rate Limiting & Anti-Spam   (theo email, theo IP, theo ngày)
//   Lớp 2: Mã hóa & lưu trữ OTP an toàn (hash HMAC, không lưu OTP dạng thô)
//   Lớp 3: Chống dò mã / brute-force    (giới hạn số lần thử, so sánh an toàn)
//   Lớp 4: Token sau xác minh           (verifyToken ngắn hạn, dùng 1 lần)
// ================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Nếu chạy sau reverse proxy (Render, Railway, Vercel...), cần bật trust proxy
// để req.ip lấy đúng IP thật của người dùng thay vì IP của proxy nội bộ.
// Không ảnh hưởng gì khi chạy local (localhost).
app.set('trust proxy', 1);

// Cho phép gọi từ domain khác nếu sau này tách frontend ra host riêng.
// Mặc định '*' vì API không dùng cookie/session, chỉ nhận email + otp trong body.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Phục vụ toàn bộ file tĩnh (index.html, ảnh, v.v.) trong thư mục public/
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// Cấu hình gửi mail qua SMTP (Nodemailer) — dùng biến môi trường,
// không hard-code thông tin nhạy cảm trong code.
// Ví dụ dùng Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587,
// SMTP_USER=ban@gmail.com, SMTP_PASS=<App Password 16 ký tự>.
// ---------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true nếu port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER;

// ---------------------------------------------------------------
// LỚP 2 — Khóa bí mật để hash OTP & ký verifyToken.
// Nên đặt OTP_SECRET cố định trong .env để token/hash ổn định qua các lần
// deploy; nếu không set, server tự sinh 1 khóa ngẫu nhiên lúc khởi động
// (vẫn an toàn, chỉ có nhược điểm là mọi verifyToken đang treo sẽ mất
// hiệu lực nếu server restart giữa chừng — chấp nhận được vì token sống
// rất ngắn, chỉ vài phút).
// ---------------------------------------------------------------
const OTP_SECRET = process.env.OTP_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.OTP_SECRET) {
  console.warn('[Cảnh báo] Chưa set OTP_SECRET trong .env — server tự sinh khóa tạm thời cho phiên chạy này.');
}

function hmac(payload){
  return crypto.createHmac('sha256', OTP_SECRET).update(payload).digest('hex');
}

// So sánh 2 chuỗi hex bằng thời gian không đổi, tránh timing attack khi so OTP.
function safeEqualHex(a, b){
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------
// Lưu OTP tạm thời trong bộ nhớ server (Map). Với Render free tier,
// service có thể "ngủ" và khởi động lại sau một thời gian không có
// request — khi đó Map này sẽ trống, user chỉ cần bấm "Gửi lại mã".
// Nếu cần OTP sống sót qua nhiều lần khởi động/nhiều instance, có thể
// thay Map này bằng một bảng nhỏ trong Firebase Realtime Database.
//
// LỚP 2: chỉ lưu otpHash (HMAC-SHA256), KHÔNG lưu mã OTP dạng thô —
// nếu bộ nhớ server bị đọc trộm (log, dump, lỗi debug lộ ra ngoài...)
// kẻ tấn công cũng không lấy được mã thật.
// ---------------------------------------------------------------
const otpStore = new Map(); // key: `${purpose}:${email}` -> { otpHash, expiresAt, attempts, lastSentAt, lockedUntil }

const OTP_TTL_MS = 10 * 60 * 1000;       // mã sống 10 phút
const RESEND_COOLDOWN_MS = 60 * 1000;    // giữa 2 lần gửi cách nhau tối thiểu 60s
const MAX_VERIFY_ATTEMPTS = 5;           // nhập sai quá 5 lần thì bị khóa tạm
const VERIFY_LOCKOUT_MS = 5 * 60 * 1000; // khóa 5 phút sau khi vượt quá số lần thử

function otpKey(email, purpose){
  return `${purpose}:${email.trim().toLowerCase()}`;
}

function isValidGmail(email){
  return typeof email === 'string' && /^[a-zA-Z0-9._%+-]+@gmail\.com$/i.test(email.trim());
}

function generateOtp(){
  // crypto.randomInt an toàn hơn Math.random() cho mục đích bảo mật.
  return String(crypto.randomInt(100000, 1000000)); // 6 chữ số: 100000-999999
}

function hashOtp(otp, email, purpose){
  return hmac(`otp:${purpose}:${email.trim().toLowerCase()}:${otp}`);
}

// Dọn các mã đã hết hạn định kỳ để không phình bộ nhớ mãi.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt && (!entry.lockedUntil || now > entry.lockedUntil)) {
      otpStore.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------
// LỚP 1 — Rate limiting & chống spam theo IP.
// Áp dụng 2 tầng giới hạn độc lập với cooldown theo email ở trên:
//   - Giới hạn số lần GỬI YÊU CẦU OTP theo IP trong 1 cửa sổ thời gian
//     (chặn 1 người dùng nhiều email khác nhau để né cooldown-theo-email).
//   - Giới hạn số lần GỬI THÀNH CÔNG tới CÙNG 1 EMAIL trong 1 ngày
//     (chặn việc spam hòm mail của người khác dù đổi IP liên tục).
// Toàn bộ lưu trong bộ nhớ (đủ dùng cho 1 instance Render free tier).
// ---------------------------------------------------------------
const ipRequestLog = new Map();   // ip -> { count, windowStart }
const emailDailyLog = new Map();  // `${purpose}:${email}` -> { count, dayStart }
const ipVerifyLog = new Map();    // ip -> { count, windowStart } (chống dò mã dàn trải nhiều email)

const IP_REQUEST_WINDOW_MS = 15 * 60 * 1000; // cửa sổ 15 phút
const IP_REQUEST_MAX = 8;                    // tối đa 8 lần xin OTP / IP / 15 phút

const EMAIL_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 ngày
const EMAIL_DAILY_MAX = 10;                          // tối đa 10 mã gửi tới cùng 1 email / ngày

const IP_VERIFY_WINDOW_MS = 15 * 60 * 1000; // cửa sổ 15 phút
const IP_VERIFY_MAX = 30;                    // tối đa 30 lần verify / IP / 15 phút

function clientIp(req){
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// Trả về { allowed, waitSec } — dùng chung cho các bộ đếm dạng cửa sổ trượt đơn giản.
function checkWindowLimit(map, key, windowMs, max){
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= max) {
    const waitSec = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
    return { allowed: false, waitSec };
  }
  entry.count += 1;
  return { allowed: true };
}

// Dọn log rate-limit cũ định kỳ.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipRequestLog) if (now - v.windowStart > IP_REQUEST_WINDOW_MS) ipRequestLog.delete(k);
  for (const [k, v] of emailDailyLog) if (now - v.windowStart > EMAIL_DAILY_WINDOW_MS) emailDailyLog.delete(k);
  for (const [k, v] of ipVerifyLog) if (now - v.windowStart > IP_VERIFY_WINDOW_MS) ipVerifyLog.delete(k);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------
// LỚP 4 — Token xác minh ngắn hạn, cấp sau khi verify OTP thành công.
// Token ký bằng HMAC (email + purpose + hạn dùng + số ngẫu nhiên), sống
// 5 phút, dùng ĐƯỢC ĐÚNG 1 LẦN (đánh dấu đã dùng trong usedVerifyTokens).
// Mục đích: tách rõ 2 bước "đã xác minh OTP" và "thực hiện hành động
// nhạy cảm sau đó" (tạo tài khoản / đổi mật khẩu), để nếu sau này có
// thêm API nhạy cảm ở backend thì bắt buộc phải kèm token này, thay vì
// tin tưởng mù quáng rằng client đã verify.
//
// Lưu ý: hành động cuối (ghi mật khẩu vào Firebase Realtime Database)
// hiện tại vẫn được frontend thực hiện trực tiếp từ trình duyệt, không
// đi qua backend — nên lớp này chưa gate được bước đó. Nó đã sẵn sàng
// để dùng ngay khi có API backend nào cần "đã xác minh email" làm điều
// kiện. Chi tiết xem README mục "Lớp 4".
// ---------------------------------------------------------------
const usedVerifyTokens = new Set();
const VERIFY_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 phút

function issueVerifyToken(email, purpose){
  const payload = {
    email: email.trim().toLowerCase(),
    purpose,
    exp: Date.now() + VERIFY_TOKEN_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(`vt:${body}`);
  return `${body}.${sig}`;
}

function verifyVerifyToken(token, email, purpose){
  if (typeof token !== 'string' || !token.includes('.')) return false;
  if (usedVerifyTokens.has(token)) return false;
  const [body, sig] = token.split('.');
  const expectedSig = hmac(`vt:${body}`);
  if (!safeEqualHex(sig, expectedSig)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return false; }
  if (payload.email !== email.trim().toLowerCase() || payload.purpose !== purpose) return false;
  if (Date.now() > payload.exp) return false;
  usedVerifyTokens.add(token);
  return true;
}

// Dọn token đã dùng cũ (chỉ cần giữ trong TTL, sau đó chữ ký tự hết hạn nên xóa vô tư).
setInterval(() => usedVerifyTokens.clear(), 30 * 60 * 1000).unref();

// ---------------------------------------------------------------
// POST /api/otp/request  { email, purpose: 'register' | 'reset' }
// Tạo mã OTP mới, lưu ở server (đã hash), gửi email cho user.
// ---------------------------------------------------------------
app.post('/api/otp/request', async (req, res) => {
  try {
    const { email, purpose } = req.body || {};
    if (!isValidGmail(email)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (purpose !== 'register' && purpose !== 'reset') {
      return res.status(400).json({ error: 'invalid_purpose' });
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error('Thiếu cấu hình SMTP_HOST/SMTP_USER/SMTP_PASS trong biến môi trường.');
      return res.status(500).json({ error: 'mail_not_configured' });
    }

    // --- LỚP 1a: giới hạn theo IP (chặn spam nhiều email khác nhau từ 1 nguồn) ---
    const ip = clientIp(req);
    const ipCheck = checkWindowLimit(ipRequestLog, ip, IP_REQUEST_WINDOW_MS, IP_REQUEST_MAX);
    if (!ipCheck.allowed) {
      return res.status(429).json({ error: 'ip_rate_limited', waitSec: ipCheck.waitSec });
    }

    // --- LỚP 1b: giới hạn theo email/ngày (chặn spam hòm mail 1 nạn nhân) ---
    const dailyKey = otpKey(email, purpose);
    const dailyCheck = checkWindowLimit(emailDailyLog, dailyKey, EMAIL_DAILY_WINDOW_MS, EMAIL_DAILY_MAX);
    if (!dailyCheck.allowed) {
      return res.status(429).json({ error: 'daily_limit', waitSec: dailyCheck.waitSec });
    }

    // --- LỚP 1c: cooldown 60s giữa 2 lần gửi cho cùng 1 email+purpose ---
    const key = otpKey(email, purpose);
    const existing = otpStore.get(key);
    if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
      return res.status(429).json({ error: 'cooldown', waitSec });
    }

    const otp = generateOtp();
    const expiresAt = Date.now() + OTP_TTL_MS;
    // LỚP 2: chỉ lưu hash của OTP, không lưu OTP dạng thô.
    otpStore.set(key, {
      otpHash: hashOtp(otp, email, purpose),
      expiresAt,
      attempts: 0,
      lastSentAt: Date.now(),
      lockedUntil: 0,
    });

    const subject = purpose === 'register'
      ? 'Mã xác minh đăng ký — MeoMeoFindMovie'
      : 'Mã xác minh đổi mật khẩu — MeoMeoFindMovie';
    const timeLabel = new Date(expiresAt).toLocaleTimeString('vi-VN');

    await transporter.sendMail({
      from: MAIL_FROM,
      to: email,
      subject,
      text: `Mã xác minh của bạn là: ${otp}\nMã có hiệu lực đến ${timeLabel} (10 phút kể từ bây giờ).\nNếu bạn không yêu cầu mã này, hãy bỏ qua email.`,
      html: `
        <div style="font-family:sans-serif; font-size:15px; color:#111;">
          <p>Mã xác minh của bạn là:</p>
          <p style="font-size:28px; font-weight:700; letter-spacing:4px;">${otp}</p>
          <p>Mã có hiệu lực đến <b>${timeLabel}</b> (10 phút kể từ bây giờ).</p>
          <p style="color:#888; font-size:13px;">Nếu bạn không yêu cầu mã này, hãy bỏ qua email này.</p>
        </div>
      `,
    });

    res.json({ ok: true, expiresAt, cooldownSec: RESEND_COOLDOWN_MS / 1000 });
  } catch (err) {
    console.error('Lỗi /api/otp/request:', err);
    res.status(500).json({ error: 'send_failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/otp/verify  { email, purpose, otp }
// Kiểm tra mã OTP. Đúng thì xóa mã (dùng 1 lần), cấp verifyToken ngắn
// hạn, và trả ok:true.
// ---------------------------------------------------------------
app.post('/api/otp/verify', (req, res) => {
  const { email, purpose, otp } = req.body || {};
  if (!isValidGmail(email) || (purpose !== 'register' && purpose !== 'reset') || !otp) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // --- LỚP 3a: giới hạn theo IP tổng số lần verify (chặn dò mã dàn trải nhiều email) ---
  const ip = clientIp(req);
  const ipCheck = checkWindowLimit(ipVerifyLog, ip, IP_VERIFY_WINDOW_MS, IP_VERIFY_MAX);
  if (!ipCheck.allowed) {
    return res.status(429).json({ error: 'ip_rate_limited', waitSec: ipCheck.waitSec });
  }

  const key = otpKey(email, purpose);
  const entry = otpStore.get(key);
  if (!entry) {
    return res.status(400).json({ error: 'expired' });
  }
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ error: 'expired' });
  }
  // --- LỚP 3b: khóa tạm thời sau khi vượt quá số lần thử sai ---
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const waitSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: 'too_many_attempts', waitSec });
  }
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    entry.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
    return res.status(429).json({ error: 'too_many_attempts', waitSec: VERIFY_LOCKOUT_MS / 1000 });
  }

  // --- LỚP 3c: so sánh hash bằng thời gian không đổi (chống timing attack) ---
  const candidateHash = hashOtp(String(otp).trim(), email, purpose);
  if (!safeEqualHex(candidateHash, entry.otpHash)) {
    entry.attempts += 1;
    return res.status(400).json({ error: 'invalid', attemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - entry.attempts) });
  }

  otpStore.delete(key); // mã chỉ dùng được 1 lần

  // --- LỚP 4: cấp verifyToken ngắn hạn, dùng 1 lần, cho bước tiếp theo ---
  const verifyToken = issueVerifyToken(email, purpose);
  res.json({ ok: true, verifyToken, verifyTokenExpiresInSec: VERIFY_TOKEN_TTL_MS / 1000 });
});

// Kiểm tra nhanh service còn sống (Render health check có thể dùng route này).
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Mọi route không khớp API/tĩnh khác thì trả về index.html (SPA-style fallback).
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});
