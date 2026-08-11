# MeoMeoFindMovie — Deploy lên Vercel

## Cấu trúc project

```
.
├── server.js          # Backend Express: phục vụ frontend + API gửi/xác minh OTP qua email
├── package.json
├── .env.example       # Mẫu biến môi trường (copy thành .env khi chạy local)
├── vercel.json         # Config để Vercel biết cách build/route request
└── public/
    └── index.html      # Toàn bộ frontend (đã bỏ EmailJS, gọi API của server.js)
```

Firebase (Realtime Database + Authentication) **không đổi gì** — `index.html` vẫn gọi
thẳng Firebase SDK từ trình duyệt như trước, chỉ có phần gửi mã OTP là chuyển từ
EmailJS sang backend Node.js tự viết.

## 1. Chạy thử ở máy local

```bash
npm install
cp .env.example .env      # rồi điền SMTP_USER / SMTP_PASS thật vào .env
npm start
```

Mở `http://localhost:10000` (server lắng nghe ở PORT 10000, xem mục 2).

## 2. Cấu hình gửi email (SMTP)

Cách nhanh nhất, miễn phí: dùng Gmail làm SMTP relay.

1. Bật xác minh 2 bước cho tài khoản Gmail sẽ dùng để gửi mail.
2. Vào https://myaccount.google.com/apppasswords, tạo một "App Password" (mật khẩu ứng dụng 16 ký tự).
3. Dùng các giá trị sau (điền vào `.env` khi chạy local, hoặc vào Environment Variables trên Vercel):
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587`
   - `SMTP_SECURE=false`
   - `SMTP_USER=ban@gmail.com`
   - `SMTP_PASS=<app password 16 ký tự>`
   - `MAIL_FROM="MeoMeoFindMovie <ban@gmail.com>"`
   - `PORT=10000`

Gmail free giới hạn khoảng 500 email/ngày — đủ dùng cho web nhỏ. Nếu cần gửi nhiều
hơn hoặc không muốn dùng Gmail cá nhân, có thể thay bằng SMTP của Resend, Brevo
(Sendinblue), Mailgun... chỉ cần đổi 4 biến `SMTP_*` ở trên, code không cần sửa gì thêm.

## 3. Deploy lên Vercel

### Cách 1 — dùng Vercel Dashboard (nhanh nhất)

1. Đẩy toàn bộ thư mục này lên một repo GitHub/GitLab.
2. Vào Vercel Dashboard → **Add New** → **Project** → import repo vừa tạo.
3. Vercel tự nhận diện Node project. Cấu hình:
   - **Build Command**: `npm install`
   - **Output/Start**: Vercel chạy `npm start`, server lắng nghe ở `PORT=10000`
     (đặt biến này trong Environment Variables, xem bên dưới).
4. Trong tab **Settings → Environment Variables**, thêm: `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `OTP_SECRET`, và `PORT=10000`.
5. Bấm **Deploy**.

### Cách 2 — dùng Vercel CLI

```bash
npm i -g vercel
vercel login
vercel          # deploy bản preview
vercel --prod   # deploy bản production
```

Vercel sẽ hỏi/đọc `vercel.json` để biết cách route request vào `server.js`. Nhớ set
các biến môi trường ở trên bằng `vercel env add <TÊN_BIẾN>` (hoặc set sẵn trong
Dashboard trước khi deploy) — bao gồm cả `PORT=10000`.

Sau khi deploy, Vercel sẽ cấp cho bạn một domain dạng `https://ten-app.vercel.app`.

## 4. Sau khi deploy — nhớ kiểm tra Firebase

Vào **Firebase Console → Authentication → Settings → Authorized domains**, thêm domain
Vercel mới (vd `ten-app.vercel.app`) vào danh sách. Nếu không thêm, đăng nhập admin
bằng Firebase Authentication (Email/Password) trên domain mới có thể bị chặn.

Realtime Database Rules không cần đổi gì — vẫn dựa trên `auth.uid`, không phụ thuộc domain.

## 5. Lưu ý khi chạy trên Vercel

- Server lắng nghe ở cổng cố định `PORT=10000` — nhớ set biến môi trường này trong
  Vercel (mục 3), nếu không server có thể không nhận đúng cổng mà Vercel forward request tới.
- Mã OTP đang được lưu tạm trong bộ nhớ (`Map`) của server. Với môi trường serverless/
  auto-scale như Vercel, mỗi lần cold start hoặc mỗi instance khác nhau có thể có bộ nhớ
  riêng — nếu user xin mã ở một instance rồi verify rơi vào instance khác, có thể gặp lỗi
  "invalid/expired" dù mã còn hạn. Nếu gặp tình trạng này, bấm **"Gửi lại mã"** để thử lại,
  hoặc chuyển sang lưu OTP ở nơi dùng chung được (xem gợi ý bên dưới).
- Nếu sau này muốn mã OTP không bị mất/không bị lệch giữa các instance, có thể chuyển
  việc lưu OTP từ `Map` trong `server.js` sang một nhánh riêng trong Firebase Realtime
  Database (vd `otp/{key}`) — cấu trúc code đã tách riêng phần lưu/đọc OTP (`otpStore`)
  nên khi cần thì chỉ sửa trong `server.js`, không đụng gì đến `index.html`.

## 6. Hệ thống phòng vệ OTP (4 lớp)

Toàn bộ nằm trong `server.js`:

**Lớp 1 — Rate Limiting & Anti-Spam**
- Cooldown 60 giây giữa 2 lần gửi mã cho cùng 1 email (client cũng tự chặn trước, server chặn lại lần nữa để không bị bỏ qua bằng cách gọi thẳng API).
- Giới hạn 8 lần xin mã / IP / 15 phút — chặn 1 người dùng nhiều email khác nhau để né cooldown-theo-email.
- Giới hạn 10 mã / email / ngày — chặn spam hòm mail của người khác dù họ đổi IP liên tục.

**Lớp 2 — Mã hóa & lưu trữ OTP**
- Mã OTP không lưu dạng thô trong bộ nhớ server, chỉ lưu bản băm HMAC-SHA256 (khóa lấy từ `OTP_SECRET`). Nếu bộ nhớ server bị lộ (log, dump, lỗi debug) cũng không đọc được mã thật.
- Mã vẫn sinh bằng `crypto.randomInt` (an toàn hơn `Math.random`).

**Lớp 3 — Chống dò mã / Brute-force**
- Tối đa 5 lần nhập sai / mã, sau đó khóa 5 phút cho email+mục đích đó (`too_many_attempts`).
- Giới hạn thêm 30 lần verify / IP / 15 phút — chặn kiểu dò mã dàn trải qua nhiều email khác nhau từ cùng 1 nguồn.
- So sánh mã bằng `crypto.timingSafeEqual` (constant-time) để tránh timing attack.

**Lớp 4 — Token sau xác minh**
- Khi verify đúng, server cấp thêm `verifyToken` ký bằng HMAC, sống 5 phút, dùng được đúng 1 lần.
- Mục đích: tách rõ "đã xác minh OTP" khỏi "được phép làm hành động nhạy cảm tiếp theo" — sẵn sàng để dùng ngay khi backend có thêm API cần điều kiện "email đã xác minh".
- **Giới hạn cần biết:** hiện tại bước tạo tài khoản / đổi mật khẩu vẫn do **frontend ghi thẳng vào Firebase Realtime Database** từ trình duyệt, không đi qua backend, nên lớp 4 chưa gate được bước đó — nó bảo vệ đúng phạm vi backend (API OTP), còn phần ghi dữ liệu vẫn phụ thuộc vào Firebase Security Rules (`auth.uid`) như đã có.

Nhớ đặt biến `OTP_SECRET` trong `.env` (xem `.env.example`) — nếu bỏ trống, server vẫn chạy được nhưng tự sinh khóa ngẫu nhiên mỗi lần khởi động lại, khiến các `verifyToken` đang treo bị mất hiệu lực khi restart.

## 7. API mà frontend gọi tới backend

- `POST /api/otp/request` — body `{ email, purpose: "register" | "reset" }`, trả về
  `{ ok: true, expiresAt }` hoặc lỗi (`invalid_email`, `cooldown`, `mail_not_configured`...).
- `POST /api/otp/verify` — body `{ email, purpose, otp }`, trả về `{ ok: true }` hoặc
  `{ error: "expired" | "invalid" | "too_many_attempts" }`.
- `GET /api/health` — kiểm tra service còn sống.

Mã OTP thật (giá trị 6 số) **không** còn nằm ở phía trình duyệt nữa — chỉ backend giữ,
nên mở Console (F12) trên trang cũng không đọc được mã như cách làm cũ.
