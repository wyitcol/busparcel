import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_ACCOUNT_REFERENCE = "BusParcel";

interface MpesaStkPushRequest {
  phone?: string;
  amount?: number;
  parcel_id?: string;
  account_reference?: string;
  simulate?: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const rawBody: unknown = await req.json();
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { phone, amount, parcel_id, account_reference, simulate } = rawBody as MpesaStkPushRequest;

    if (
      (typeof phone !== "string" && typeof phone !== "number") ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      typeof parcel_id !== "string" ||
      !parcel_id.trim()
    ) {
      return new Response(
        JSON.stringify({ error: "Invalid required fields: phone, amount, parcel_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Format phone: ensure it starts with 2547XXXXXXXX
    let formattedPhone = String(phone).replace(/\D/g, "");
    if (formattedPhone.startsWith("0")) {
      formattedPhone = `254${formattedPhone.slice(1)}`;
    } else if (formattedPhone.startsWith("7") && formattedPhone.length === 9) {
      formattedPhone = `254${formattedPhone}`;
    } else if (formattedPhone.startsWith("25407")) {
      formattedPhone = `254${formattedPhone.slice(4)}`;
    }

    if (!/^2547\d{8}$/.test(formattedPhone)) {
      return new Response(
        JSON.stringify({ error: "Invalid phone number format. Use a Safaricom number like 07XXXXXXXX or 2547XXXXXXXX." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    if (simulate === true) {
      const simulatedReceipt = `SIM${Date.now().toString().slice(-8)}`;
      await supabase
        .from("parcels")
        .update({
          payment_status: "paid",
          payment_amount: amount,
          mpesa_phone: formattedPhone,
          mpesa_receipt: simulatedReceipt,
        })
        .eq("id", parcel_id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Payment processed successfully (simulated M-Pesa).",
          receipt: simulatedReceipt,
          simulated: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const consumerKey = Deno.env.get("MPESA_CONSUMER_KEY");
    const consumerSecret = Deno.env.get("MPESA_CONSUMER_SECRET");
    const shortcode = Deno.env.get("MPESA_SHORTCODE");
    const passkey = Deno.env.get("MPESA_PASSKEY");
    const environment = Deno.env.get("MPESA_ENVIRONMENT")?.toLowerCase() === "production" ? "production" : "sandbox";
    const baseUrl = environment === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
      return new Response(
        JSON.stringify({
          error: "M-Pesa is not configured. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, and MPESA_PASSKEY.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const auth = btoa(`${consumerKey}:${consumerSecret}`);
    const tokenRes = await fetch(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("M-Pesa auth failed:", JSON.stringify(tokenData));
      return new Response(
        JSON.stringify({
          error: "Failed to authenticate with M-Pesa. Confirm credentials and MPESA_ENVIRONMENT (sandbox/production).",
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
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: account_reference || DEFAULT_ACCOUNT_REFERENCE,
      TransactionDesc: `Payment for parcel ${account_reference || DEFAULT_ACCOUNT_REFERENCE}`,
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
      console.error("M-Pesa STK request failed:", JSON.stringify(stkData));
      return new Response(
        JSON.stringify({
          error: stkData.errorMessage || stkData.ResponseDescription || "STK push request was rejected by M-Pesa.",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase
      .from("parcels")
      .update({
        payment_status: "pending",
        payment_amount: amount,
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
  } catch (error) {
    console.error("M-Pesa STK Push error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
