import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { StoreList } from "./components/StoreList";
import { StoreDetail } from "./components/StoreDetail";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<StoreList />} />
        <Route path="/stores/:id" element={<StoreDetail />} />
      </Routes>
    </Layout>
  );
}
