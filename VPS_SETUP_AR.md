# تشغيل ماسح Kamal على VPS طوال اليوم

هذا المسار يجعل الخدمة تعمل على خادم دائم بدل جهازك المنزلي. **الخادم نفسه يحتاج اتصال إنترنت دائمًا** لمصادر أسعار الكريبتو ولإرسال تنبيهات Telegram. لا يضع هذا الإعداد مفاتيح محفظة ولا يفعّل تداولًا حيًا: النظام PAPER فقط.

## ما تحتاجه قبل البدء

- VPS Ubuntu 22.04/24.04 بعنوان IP عام، وحساب SSH بصلاحية `sudo`.
- اسم نطاق تملكه، مع سجل DNS من نوع A يشير إلى IP الخادم. يلزم DNS وشبكة 80/443 حتى ينشئ Caddy شهادة HTTPS تلقائيًا.
- Node.js 20 أو أحدث على الخادم، وCaddy.
- احفظ `.env` خارج المستودع، ولا تلصق أسرار Telegram أو ADMIN_TOKEN في GitHub.

## التثبيت

1. ارفع مجلد المشروع إلى `/opt/kamal-moonshot-local` على الخادم عبر SSH/SFTP، أو استنسخ مستودعك الخاص هناك. لا ترفع مجلد `data/` أو ملف `.env`.
2. ثبّت Node.js 20+ وCaddy من مستودعاتهما الرسمية، ثم أنشئ مستخدمًا ومجلد بيانات:

   ```sh
   sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin kamal-scanner
   sudo install -d -o kamal-scanner -g kamal-scanner -m 700 /var/lib/kamal-moonshot-scanner
   sudo chown -R root:root /opt/kamal-moonshot-local
   sudo chmod -R go-w /opt/kamal-moonshot-local
   ```

3. أنشئ ملف الإعدادات السري خارج المشروع:

   ```sh
   sudo install -m 600 /dev/null /etc/kamal-moonshot-scanner.env
   sudo nano /etc/kamal-moonshot-scanner.env
   ```

   ضع هذه القيم، واستبدل النطاق، وأنشئ رمزًا عشوائيًا طويلًا وفريدًا:

   ```dotenv
   HOST=127.0.0.1
   PORT=8787
   DATA_DIR=/var/lib/kamal-moonshot-scanner
   PUBLIC_ORIGIN=https://scanner.example.com
   ADMIN_TOKEN=ضع_هنا_رمزًا_عشوائيًا_طوله_32_حرفًا_على_الأقل
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   ```

   لتوليد رمز مناسب على Linux: `openssl rand -hex 32`. لا تستخدم قيمة المثال كما هي. ضع بيانات Telegram الاختيارية في هذا الملف فقط؛ راجع [TELEGRAM_SETUP_AR.md](TELEGRAM_SETUP_AR.md) لاستخراج `chat_id` بأمان واختبار الرسائل.

4. عدّل `scanner.example.com` في `vps/Caddyfile.example` إلى نطاقك، ثم ثبّت الإعداد:

   ```sh
   sudo cp /opt/kamal-moonshot-local/vps/kamal-moonshot.service /etc/systemd/system/
   sudo cp /opt/kamal-moonshot-local/vps/Caddyfile.example /etc/caddy/Caddyfile
   sudo systemctl daemon-reload
   sudo systemctl enable --now kamal-moonshot
   sudo systemctl enable --now caddy
   ```

5. اسمح بجدار الحماية بـSSH وHTTP/HTTPS فقط، ولا تفتح المنفذ 8787 للعامة:

   ```sh
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

6. افتح `https://scanner.example.com`. عند أول دخول، أدخل `ADMIN_TOKEN` في نافذة الاتصال. اضغط «تشغيل PAPER» وتحقق من حالة المصادر وTelegram.

## التحديث والمراقبة

- الحالة والسجلات: `sudo systemctl status kamal-moonshot` و`sudo journalctl -u kamal-moonshot -f`.
- إعادة تشغيل بعد التحديث: أوقف الخدمة، حدّث ملفات المشروع من مصدر موثوق، ثم `sudo systemctl restart kamal-moonshot`.
- انسخ `/var/lib/kamal-moonshot-scanner` احتياطيًا؛ فيه سجل المحاكاة والنتائج. لا تضع النسخ في مستودع عام.
- راقب مساحة القرص والذاكرة، تجديد HTTPS، أخطاء مصادر البيانات، وتوفر الخادم.

## حدود وأمان

- يتصل التطبيق بمصادر السوق العامة؛ تأخر المصدر أو حدوده قد يسبب تأخر/فقد إشارات. وجود VPS لا يجعل مصدر البيانات أسرع أو مضمونًا.
- الواجهة متاحة على النطاق، لكن أوامر API محمية برمز الإدارة. استخدم HTTPS، رمزًا عشوائيًا قويًا، ولا تشارك الرابط مع أشخاص غير موثوقين.
- يظل Node مربوطًا بـ`127.0.0.1`، ويفتح الوصول عبر Caddy فقط. وضع النطاق يقبل أصل HTTPS المحدد بالضبط، ويرفض بقية الأصول والطلبات العابرة للمواقع.
- لا تستخدم `HOST=0.0.0.0`، ولا تفتح 8787 في جدار الحماية، ولا تضف `.env` إلى Git.
- لا أستطيع إنشاء حساب VPS أو تغيير DNS نيابةً عنك من دون وصول لحساباتك؛ هذا الدليل يجهز المشروع لتشغيله بأمان نسبي على خادم تملكه.
