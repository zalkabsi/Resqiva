# Resqiva video production prompt

Create a polished **2 minute 20 second maximum** product-demo video for Resqiva, formatted in 16:9 for YouTube. Use the supplied real screen recording of the live Resqiva app and the narration in [resqiva-demo-narration.md](resqiva-demo-narration.md). Keep the complete video under 3 minutes.

Use a clear, natural English neural voice from **Microsoft Bing/Azure Speech** for the narration. Add accurate English subtitles synchronized to the voice. Keep the app interface large and readable; use gentle cuts and restrained zooms to draw attention to the shopper prompt, meal results, budget, item prices, pickup window, and merchant inventory view. Use a warm cream, forest-green, and soft-gold visual palette that matches the thumbnail. Keep music off so the narration and app remain clear.

Use only actual footage and details from the running project. Do not fabricate screens, products, prices, inventory, PayPal approvals, payment captures, or impact metrics. Keep the fictional-demo-data label visible when showing stores and inventory. The hosted free demo uses a deterministic local parser; it does not make Fireworks AI calls. The project includes a Fireworks-backed parser path, but show or describe it as active only if the recording actually uses that configured path.

The PayPal Sandbox integration is implemented, but Sandbox authentication currently returns `invalid_client`. No buyer approval, capture, paid order, or webhook has been verified. Do not show a mock checkout or imply that payment succeeded; use the payment-status wording in the narration.

End on the Resqiva name and the project links: https://resqiva.onrender.com and https://github.com/zalkabsi/Resqiva/tree/work. Do not include API keys, credentials, private account details, third-party logos, or copyrighted music. Export a YouTube-ready MP4 and verify its runtime is below 3:00 before upload.
