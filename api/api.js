import express from "express";
import cors from "cors";

const app = express();

// Enable CORS for all routes
app.use(cors());

app.get("/", (req, res) => {
  res.send("CORS is working!");
});

app.listen(5000, () => console.log("Server running on port 5000"));
