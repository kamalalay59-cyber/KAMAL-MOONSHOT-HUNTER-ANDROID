package com.kamal.moonshot;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;

public final class MainActivity extends Activity {
    private static final String PREFS = "moonshot_app";
    private static final String SERVER_KEY = "https_origin";
    private static final int BG = Color.rgb(3, 10, 17);
    private static final int PANEL = Color.rgb(8, 24, 34);
    private static final int BORDER = Color.rgb(25, 63, 78);
    private static final int TEXT = Color.rgb(232, 245, 247);
    private static final int MUTED = Color.rgb(150, 175, 184);
    private static final int MINT = Color.rgb(48, 224, 180);

    private SharedPreferences preferences;
    private FrameLayout root;
    private WebView webView;
    private TextView status;
    private String allowedOrigin = "";
    private boolean loadingPage = false;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        allowedOrigin = preferences.getString(SERVER_KEY, "");
        buildShell();
        if (allowedOrigin.isEmpty()) showConnectScreen();
        else showDashboard();
    }

    private void buildShell() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
    }

    private void showConnectScreen() {
        root.removeAllViews();
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER_VERTICAL);
        page.setPadding(dp(26), dp(24), dp(26), dp(24));
        root.addView(page, new FrameLayout.LayoutParams(-1, -1));

        TextView brand = text("KAMAL  AI", 27, MINT, true);
        brand.setLetterSpacing(.05f);
        page.addView(brand);
        TextView title = text("ماسح إطلاقات الميم", 22, TEXT, true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(25);
        page.addView(title, titleParams);
        TextView detail = text("اربط التطبيق بخادم VPS عبر HTTPS. الرصد وTelegram يعملان على الخادم حتى عندما يكون هاتفك مغلقًا.", 15, MUTED, false);
        detail.setLineSpacing(dp(5), 1f);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(10);
        page.addView(detail, detailParams);

        TextView safety = text("PAPER فقط · لا محفظة · لا تداول حقيقي", 13, MINT, true);
        safety.setPadding(dp(13), dp(12), dp(13), dp(12));
        safety.setBackground(round(PANEL, BORDER, 1, 12));
        LinearLayout.LayoutParams safetyParams = new LinearLayout.LayoutParams(-1, -2);
        safetyParams.topMargin = dp(26);
        page.addView(safety, safetyParams);

        Button connect = button("إعداد رابط الخادم");
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, dp(54));
        buttonParams.topMargin = dp(18);
        page.addView(connect, buttonParams);
        connect.setOnClickListener(v -> showServerDialog(null));
        TextView note = text("تحتاج أولًا إلى نطاق HTTPS يعمل على VPS. رابط 127.0.0.1 لا يعمل من خارج جهاز الخادم.", 12, MUTED, false);
        note.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(-1, -2);
        noteParams.topMargin = dp(15);
        page.addView(note, noteParams);
    }

    private void showDashboard() {
        root.removeAllViews();
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(BG);
        root.addView(shell, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), dp(8), dp(12), dp(8));
        toolbar.setBackgroundColor(PANEL);
        shell.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(56)));

        TextView mark = text("K", 20, MINT, true);
        mark.setGravity(Gravity.CENTER);
        GradientDrawable markBg = round(BG, BORDER, 1, 50);
        mark.setBackground(markBg);
        toolbar.addView(mark, new LinearLayout.LayoutParams(dp(38), dp(38)));
        TextView heading = text("KAMAL MOONSHOT", 14, TEXT, true);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, -2, 1);
        headingParams.leftMargin = dp(10);
        toolbar.addView(heading, headingParams);
        Button change = new Button(this);
        change.setText("الخادم");
        change.setTextColor(MINT);
        change.setTextSize(12);
        change.setBackgroundColor(Color.TRANSPARENT);
        toolbar.addView(change, new LinearLayout.LayoutParams(-2, dp(42)));
        change.setOnClickListener(v -> showServerDialog(allowedOrigin));

        status = text("اتصال آمن · PAPER فقط", 12, MUTED, false);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setPadding(dp(16), 0, dp(16), 0);
        shell.addView(status, new LinearLayout.LayoutParams(-1, dp(34)));

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAllowed(uri)) return false;
                String scheme = uri.getScheme();
                if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (Exception ignored) { Toast.makeText(MainActivity.this, "تعذر فتح الرابط الخارجي", Toast.LENGTH_SHORT).show(); }
                }
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadingPage = true;
                status.setText("جارٍ الاتصال بالخادم عبر HTTPS…");
            }

            @Override public void onPageFinished(WebView view, String url) {
                loadingPage = false;
                status.setText("اتصال بالخادم · وضع PAPER فقط");
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    loadingPage = false;
                    status.setText("تعذر الوصول إلى الخادم. تحقق من الإنترنت ورابط VPS.");
                }
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                    status.setText("الخادم أعاد خطأ HTTP " + response.getStatusCode());
                }
            }
        });
        shell.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        webView.loadUrl(allowedOrigin);
    }

    private boolean isAllowed(Uri uri) {
        try {
            URI base = URI.create(allowedOrigin);
            String scheme = uri.getScheme();
            int port = uri.getPort() == -1 ? 443 : uri.getPort();
            int basePort = base.getPort() == -1 ? 443 : base.getPort();
            return "https".equalsIgnoreCase(scheme)
                    && base.getHost().equalsIgnoreCase(uri.getHost())
                    && basePort == port;
        } catch (Exception ignored) { return false; }
    }

    private void showServerDialog(String current) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://scanner.example.com");
        input.setText(current == null ? "" : current);
        input.setSelectAllOnFocus(true);
        input.setPadding(dp(16), dp(14), dp(16), dp(14));
        new AlertDialog.Builder(this)
                .setTitle("رابط خادم VPS")
                .setMessage("أدخل نطاق HTTPS المنشور. لا تدخل رمز الإدارة هنا، ولا تستخدم رابط http أو 127.0.0.1.")
                .setView(input)
                .setNegativeButton("إلغاء", (dialog, which) -> { if (allowedOrigin.isEmpty()) showConnectScreen(); })
                .setPositiveButton("حفظ واتصال", (dialog, which) -> saveServer(input.getText().toString()))
                .setNeutralButton("مسح الرابط", (dialog, which) -> {
                    preferences.edit().remove(SERVER_KEY).apply();
                    allowedOrigin = "";
                    if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; }
                    showConnectScreen();
                })
                .show();
    }

    private void saveServer(String raw) {
        try {
            URI uri = URI.create(raw.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))) {
                throw new IllegalArgumentException();
            }
            allowedOrigin = uri.getScheme().toLowerCase() + "://" + uri.getRawAuthority();
            preferences.edit().putString(SERVER_KEY, allowedOrigin).apply();
            showDashboard();
        } catch (Exception ignored) {
            Toast.makeText(this, "أدخل رابط HTTPS صحيحًا مثل https://scanner.example.com", Toast.LENGTH_LONG).show();
            showServerDialog(raw);
        }
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.RIGHT);
        view.setTextDirection(View.TEXT_DIRECTION_RTL);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setTextColor(Color.rgb(2, 24, 19));
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setBackground(round(MINT, Color.rgb(30, 173, 141), 1, 12));
        return button;
    }

    private GradientDrawable round(int color, int stroke, int strokeWidth, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        if (strokeWidth > 0) drawable.setStroke(dp(strokeWidth), stroke);
        return drawable;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
