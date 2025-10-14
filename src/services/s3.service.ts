import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "../utils/logger";

export class S3Service {
  private s3Client: S3Client;
  private bucketName: string;
  private region: string;

  constructor() {
    this.region = process.env.AWS_REGION || "us-east-1";
    this.bucketName = process.env.AWS_S3_BUCKET_NAME || "";

    if (!this.bucketName) {
      throw new Error("AWS_S3_BUCKET_NAME environment variable is required");
    }

    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("AWS credentials are required");
    }

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      // Increase timeout for large files
      requestHandler: {
        connectionTimeout: 300000, // 5 minutes
        socketTimeout: 300000, // 5 minutes
      },
    });

    logger.info(
      `S3Service initialized with bucket: ${this.bucketName}, region: ${this.region}`
    );
  }

  /**
   * Upload file to S3 (for small files < 5MB)
   */
  async uploadFile(
    fileBuffer: Buffer,
    key: string,
    contentType: string,
    isPublic: boolean = false
  ): Promise<string> {
    try {
      const uploadParams = {
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      };

      const command = new PutObjectCommand(uploadParams);
      await this.s3Client.send(command);

      logger.info(`File uploaded successfully: ${key}, public: ${isPublic}`);

      if (isPublic) {
        return this.getPublicUrl(key); // Ensure bucket policy allows public access
      } else {
        return await this.getSignedUrl(key, 3600 * 24 * 7);
      }
    } catch (error) {
      logger.error(`Error uploading file to S3: ${key}`, error);
      throw new Error(
        `Failed to upload file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Upload file with streaming (for large files)
   * Uses multipart upload automatically for files > 5MB
   */
  async uploadFileStream(
    fileBuffer: Buffer,
    key: string,
    contentType: string,
    isPublic: boolean = false,
    onProgress?: (progress: number) => void
  ): Promise<string> {
    try {
      logger.info(
        `Starting streaming upload for: ${key}, size: ${(
          fileBuffer.length /
          1024 /
          1024
        ).toFixed(2)}MB`
      );

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucketName,
          Key: key,
          Body: fileBuffer,
          ContentType: contentType,
        },
        queueSize: 4, // concurrent parts
        partSize: 5 * 1024 * 1024, // 5MB parts
        leavePartsOnError: false,
      });

      // Track upload progress
      if (onProgress) {
        upload.on("httpUploadProgress", (progress) => {
          if (progress.loaded && progress.total) {
            const percentage = Math.round(
              (progress.loaded / progress.total) * 100
            );
            onProgress(percentage);
          }
        });
      }

      await upload.done();

      logger.info(`Streaming upload completed successfully: ${key}`);

      if (isPublic) {
        return this.getPublicUrl(key); // Ensure bucket policy allows public access
      } else {
        return await this.getSignedUrl(key, 3600 * 24 * 7);
      }
    } catch (error) {
      logger.error(`Error in streaming upload: ${key}`, error);
      throw new Error(
        `Failed to upload file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Get public URL for an S3 object
   */
  getPublicUrl(key: string): string {
    return `https://${this.bucketName}.s3.${
      this.region
    }.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  }

  /**
   * Generate a signed URL for temporary access
   */
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });
      return signedUrl;
    } catch (error) {
      logger.error(`Error generating signed URL for: ${key}`, error);
      throw new Error(
        `Failed to generate signed URL: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Delete file from S3
   */
  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
      logger.info(`File deleted successfully: ${key}`);
    } catch (error) {
      logger.error(`Error deleting file from S3: ${key}`, error);
      throw new Error(
        `Failed to delete file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Delete file from S3 using full URL
   */
  async deleteFileFromUrl(url: string): Promise<void> {
    try {
      const key = this.extractKeyFromUrl(url);
      await this.deleteFile(key);
    } catch (error) {
      logger.error(`Error deleting file from URL: ${url}`, error);
      throw new Error(
        `Failed to delete file from URL: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Extract S3 key from URL
   */
  private extractKeyFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);

      // Handle standard S3 URL
      if (urlObj.hostname.includes(".s3.")) {
        const pathname = decodeURIComponent(urlObj.pathname.substring(1));
        return pathname;
      }

      // Handle s3:// format
      if (urlObj.protocol === "s3:") {
        return decodeURIComponent(urlObj.pathname.substring(1));
      }

      // Handle signed URLs
      const pathname = decodeURIComponent(urlObj.pathname.substring(1));
      // Remove query parameters if present
      return pathname.split("?")[0];
    } catch (error) {
      logger.error(`Error extracting key from URL: ${url}`, error);
      throw new Error("Invalid S3 URL format");
    }
  }

  /**
   * Check if file exists in S3
   */
  async fileExists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      if (
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      logger.error(`Error checking file existence: ${key}`, error);
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(key: string): Promise<{
    size: number;
    contentType: string;
    lastModified: Date;
  }> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      return {
        size: response.ContentLength || 0,
        contentType: response.ContentType || "application/octet-stream",
        lastModified: response.LastModified || new Date(),
      };
    } catch (error) {
      logger.error(`Error getting file metadata: ${key}`, error);
      throw new Error(
        `Failed to get file metadata: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Test S3 connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: "test-connection.txt", // This file doesn't need to exist
      });

      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      // 404 is ok - means we can connect to bucket
      if (
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return true;
      }
      logger.error("S3 connection test failed:", error);
      return false;
    }
  }
}
