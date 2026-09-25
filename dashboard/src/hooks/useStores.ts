import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function useStores() {
  return useQuery({
    queryKey: ["stores"],
    queryFn: api.listStores,
    refetchInterval: 5000,
  });
}

export function useStore(id: string) {
  return useQuery({
    queryKey: ["stores", id],
    queryFn: () => api.getStore(id),
    refetchInterval: 5000,
  });
}
