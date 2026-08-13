import React, { useEffect } from "react";

export default function Rejected() {
  useEffect(() => {
    void Promise.reject(new Error("interactive TSX async failure"));
  }, []);
  return null;
}
