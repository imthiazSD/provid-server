import { Request, Response, NextFunction } from "express";
import { Project } from "../models/project.model";
import { logger } from "../utils/logger";

export class ProjectController {
  public async getProjects(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const projects = await Project.find({ userId })
        .select("title thumbnailUrl previewUrl createdAt updatedAt")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await Project.countDocuments({ userId });

      res.json({
        success: true,
        data: {
          projects: projects.map((project) => ({
            id: project._id,
            title: project.title,
            thumbnailUrl: project.thumbnailUrl,
            previewUrl: project.previewUrl,
            editLink: `/edit/${project._id}`,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          })),
          pagination: {
            current: page,
            pages: Math.ceil(total / limit),
            total,
          },
        },
      });
    } catch (error) {
      logger.error("Get projects error:", error);
      next(error);
    }
  }

  public async createProject(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { title } = req.body;

      // ✅ IMPROVED: Create project with proper default values
      const project = new Project({
        title,
        userId,
        compositionSettings: {
          videoUrl: "", // Empty string for new projects
          layers: [],
          fps: 30,
          width: 1920,
          height: 1080,
        },
      });

      await project.save();

      logger.info(`New project created: ${project._id} by user: ${userId}`);

      res.status(201).json({
        success: true,
        message: "Project created successfully",
        data: {
          project: {
            id: project._id,
            title: project.title,
            editLink: `/edit/${project._id}`,
            createdAt: project.createdAt,
          },
        },
      });
    } catch (error) {
      logger.error("Create project error:", error);
      next(error);
    }
  }

  public async getProject(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;

      const project = await Project.findOne({ _id: projectId, userId });

      if (!project) {
        res.status(404).json({
          success: false,
          message: "Project not found",
        });
        return;
      }

      res.json({
        success: true,
        data: {
          project: {
            id: project._id,
            title: project.title,
            thumbnailUrl: project.thumbnailUrl,
            previewUrl: project.previewUrl,
            compositionSettings: project.compositionSettings,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        },
      });
    } catch (error) {
      logger.error("Get project error:", error);
      next(error);
    }
  }

  public async updateProject(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const updateData = req.body;

      const project = await Project.findOneAndUpdate(
        { _id: projectId, userId },
        { ...updateData, updatedAt: new Date() },
        { new: true, runValidators: true }
      );

      if (!project) {
        res.status(404).json({
          success: false,
          message: "Project not found",
        });
        return;
      }

      logger.info(`Project updated: ${projectId} by user: ${userId}`);

      res.json({
        success: true,
        message: "Project updated successfully",
        data: {
          project: {
            id: project._id,
            title: project.title,
            compositionSettings: project.compositionSettings,
            updatedAt: project.updatedAt,
          },
        },
      });
    } catch (error) {
      logger.error("Update project error:", error);
      next(error);
    }
  }

  public async autosave(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const { compositionSettings } = req.body;

      // ✅ IMPROVED: Only update if compositionSettings is provided
      if (!compositionSettings) {
        res.status(400).json({
          success: false,
          message: "compositionSettings is required",
        });
        return;
      }

      const project = await Project.findOneAndUpdate(
        { _id: projectId, userId },
        {
          compositionSettings,
          updatedAt: new Date(),
        },
        { new: true }
      );

      if (!project) {
        res.status(404).json({
          success: false,
          message: "Project not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Project autosaved",
        data: {
          updatedAt: project.updatedAt,
        },
      });
    } catch (error) {
      logger.error("Autosave error:", error);
      next(error);
    }
  }

  public async deleteProject(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;

      const project = await Project.findOneAndDelete({
        _id: projectId,
        userId,
      });

      if (!project) {
        res.status(404).json({
          success: false,
          message: "Project not found",
        });
        return;
      }

      logger.info(`Project deleted: ${projectId} by user: ${userId}`);

      res.json({
        success: true,
        message: "Project deleted successfully",
      });
    } catch (error) {
      logger.error("Delete project error:", error);
      next(error);
    }
  }
}
