import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export function useDeleteStore() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteStore(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
  });
}
