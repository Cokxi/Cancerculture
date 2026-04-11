import { supabaseServer } from "@/lib/db/server";

export async function getContractAddress() {
  const { data, error } = await supabaseServer
    .from("app_config")
    .select("value")
    .eq("key", "contract_address")
    .single();

  if (error || !data?.value) {
    
    return "TEST_CA_NOT_SET";
  }

  return data.value;
}
