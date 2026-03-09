# Example: CIAB Gift Card Lifecycle

This is a reference scenario showing how to describe a multi-persona UX simulation for ux-simulator. This file is not consumed by code — it's documentation.

## Scenario

```
Test the gift card lifecycle with three actors:

1. Admin (http://localhost:9001/wp-admin/admin.php?page=next-admin)
   Browser: chrome-devtools-2
   - Navigate to gift cards section
   - See the empty state (no gift cards yet)
   - Activate gift cards feature
   - Configure the gift card product
   - Create a "Demo T-Shirt" product at $25

2. Buyer (http://localhost:9001/shop/?no-auto-login)
   Browser: chrome-devtools-3
   - Browse the shop
   - Find the gift card product
   - Buy a $50 gift card for the recipient
   - Complete checkout

3. Recipient (http://localhost:9001/my-account/giftcards/?no-auto-login)
   Browser: chrome-devtools (or chrome-devtools-4 if available)
   - Log in with recipient credentials
   - Redeem the gift card code from email
   - Browse the shop, find the t-shirt
   - Checkout using the gift card balance
   - Verify $25 remaining balance

4. Admin returns
   - Check the order created by the recipient
   - Verify gift card balance reflects the purchase

Record everything with narration. Output to /tmp/ux-sim-gift-cards/

Scene layout preferences:
- Admin setup scenes: admin-full
- Buyer purchasing: buyer-full
- Recipient redeeming: recipient-full
- Admin reviewing final state: split (admin + recipient side by side)
```

## What the Simulator Does

1. Parses the scenario, identifies 3 personas and their Chrome MCP assignments
2. Starts screen recording for each persona's Chrome window
3. Drives each persona through their steps sequentially (or interleaved as needed)
4. Switches recording between personas at scene boundaries
5. When stuck (e.g., can't find "Gift Cards" in sidebar), asks the calling agent
6. After all steps, stops recording and runs:
   - `record-window.sh split` to get per-persona videos
   - `trimmer.ts` to remove dead time
   - `scene-composer.ts` to compose the final multi-layout video
7. Reports results with paths, durations, and UX observations
