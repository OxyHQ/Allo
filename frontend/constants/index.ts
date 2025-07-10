import { Platform } from "react-native";

export const API_URL =
  Platform.OS === "android" ? "http://192.168.86.44:3000" : "http://192.168.86.44:3000";

export const CLOUDINARY_CLOUD_NAME = "dnjidf7zv";
export const CLOUDINARY_UPLOAD_PRESET = "images";
