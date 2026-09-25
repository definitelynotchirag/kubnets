import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CreateStoreRequest } from "@urumi/shared";

export function useCreateStore() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateStoreRequest) => api.createStore(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
  });
}
