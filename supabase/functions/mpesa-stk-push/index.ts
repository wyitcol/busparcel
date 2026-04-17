import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { phone, amount, parcel_id, account_reference, simulate } = await req.json();

    if (!phone || !amount || !parcel_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: phone, amount, parcel_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const rawPhone = String(phone).trim().replace(/\s+/g, "");
    let formattedPhone = rawPhone;
    if (formattedPhone.startsWith("+")) {
      formattedPhone = formattedPhone.slice(1);
    }
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith("7")) {
      formattedPhone = "254" + formattedPhone;
    }

    if (!/^2547\d{8}$/.test(formattedPhone)) {
      return new Response(
        JSON.stringify({
          error: "Invalid phone number. Use format 07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX, or 2547XXXXXXXX.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid amount. Amount must be a positive number." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const chargedAmount = Math.ceil(numericAmount);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const consumerKey = Deno.env.get("MPESA_CONSUMER_KEY");
    const consumerSecret = Deno.env.get("MPESA_CONSUMER_SECRET");
    const shortcode = Deno.env.get("MPESA_SHORTCODE");
    const passkey = Deno.env.get("MPESA_PASSKEY");
    const shouldSimulate = simulate === true;

    if (!shouldSimulate) {
      if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
        return new Response(
          JSON.stringify({
            error: "M-Pesa is not configured on the server. Set MPESA_* secrets or use simulate=true.",
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const environment = Deno.env.get("MPESA_ENV")?.toLowerCase() === "production"
        ? "production"
        : "sandbox";
      const baseUrl = environment === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

      const auth = btoa(`${consumerKey}:${consumerSecret}`);
      const tokenRes = await fetch(
        `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.access_token) {
        return new Response(
          JSON.stringify({
            error: "Failed to get M-Pesa access token.",
            details: tokenData,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[-T:.Z]/g, "")
        .slice(0, 14);
      const password = btoa(`${shortcode}${passkey}${timestamp}`);
      const callbackUrl = `${supabaseUrl}/functions/v1/mpesa-callback`;

      const stkPayload = {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: chargedAmount,
        PartyA: formattedPhone,
        PartyB: shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: account_reference || "BusParcel",
        TransactionDesc: `Payment for parcel ${account_reference || "BusParcel"}`,
      };

      const stkRes = await fetch(
        `${baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(stkPayload),
        }
      );
      const stkData = await stkRes.json();

      if (!stkRes.ok || stkData.ResponseCode !== "0") {
        return new Response(
          JSON.stringify({
            error: stkData.errorMessage || stkData.ResponseDescription || "STK push request failed.",
            details: stkData,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      await supabase
        .from("parcels")
        .update({
          payment_status: "pending",
          payment_amount: chargedAmount,
          mpesa_phone: formattedPhone,
        })
        .eq("id", parcel_id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "STK Push sent. Check your phone.",
          checkout_request_id: stkData.CheckoutRequestID,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Simulated payment flow for demo/testing
    const fakeReceipt = "SIM" + Date.now().toString().slice(-8);
    
    await supabase
      .from("parcels")
      .update({
        payment_status: "paid",
        payment_amount: chargedAmount,
        mpesa_phone: formattedPhone,
        mpesa_receipt: fakeReceipt,
      })
      .eq("id", parcel_id);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Payment processed successfully (simulated M-Pesa).",
        receipt: fakeReceipt,
        simulated: true,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("M-Pesa STK Push error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
