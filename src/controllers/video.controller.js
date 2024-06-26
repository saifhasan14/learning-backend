import mongoose, { isValidObjectId } from "mongoose"
import { Video } from "../models/video.model.js"
import { User } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"
import { uploadOnCloudinary } from "../utils/cloudinary.js"


//TODO: get all videos based on query, sort, pagination
const getAllVideos = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, query, sortBy, sortType, userId } = req.query
})

// get video, upload to cloudinary, create video
const publishAVideo = asyncHandler(async (req, res) => {
    const { title, description } = req.body

    if (
        [title, description].some((feild) => {
            feild?.trim() === ""
        })
    ) {
        throw new ApiError(400, "tilte and description are required")
    }

    let videoLocalPath
    let thumbnailLocalPath
    if (req.files && Array.isArray(req.files.video) && req.files.video.length > 0) {
        videoLocalPath = req.files.video[0].path
    }
    if (req.files && Array.isArray(req.files.thumbnail) && req.files.thumbnail.length > 0) {
        thumbnailLocalPath = req.files.thumbnail[0].path
    }

    if (!videoLocalPath) {
        throw new ApiError(400, "videoLocalPath is required");
    }

    if (!thumbnailLocalPath) {
        throw new ApiError(400, "thumbnailLocalPath is required");
    }

    const videoFile = await uploadOnCloudinary(videoLocalPath)
    const thumbnail = await uploadOnCloudinary(thumbnailLocalPath)

    if (!videoFile) {
        throw new ApiError(400, "Video file not found");
    }

    if (!thumbnail) {
        throw new ApiError(400, "Thumbnail not found");
    }

    const video = Video.create({
        title,
        description,
        duration: videoFile.duration,
        videoFile: {
            url: videoFile.url,
            public_id: videoFile.public_id
        },
        thumbnail: {
            url: thumbnail.url,
            public_id: thumbnail.public_id
        },
        owner: req.user._id,
        isPublished: false
    })

    const uploadedVideo = await Video.findById(video)

    if (!uploadedVideo) {
        throw new ApiError(500, "Video uploading failed, Please try again !!! ")
    }

    return res
        .status(200)
        .json(new ApiResponse(200, uploadedVideo, "video Uploaded succesfully"))

})

// get video by id
const getVideoById = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid VideoId")
    }

    if (!isValidObjectId(req.user?._id)) {
        throw new ApiError(400, "Invalid userId");
    }

    const video = await Video.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(videoId)
            }
        },
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes"
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                //sub pipeline after getting docs of owner
                pipeline: [
                    {
                        $lookup: {
                            from: "subscriptions",
                            localField: "_id",
                            foreignField: "channel",
                            as: "subscribers",
                        }
                    },
                    {
                        $addFields: {
                            susbscriberCount: {
                                $size: "$subscribers"
                            },
                            isSubscribed: {
                                $cond: {
                                    if: {
                                        $in: [
                                            req.user?._id,
                                            "$subscribers.subscriber"
                                        ]
                                    },
                                    then: true,
                                    else: false
                                }
                            }
                        }
                    },
                    {
                        $project: {
                            fullName: 1,
                            username: 1,
                            "avatar.url": 1,
                            subscribersCount: 1,
                            isSubscribed: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                likesCount: {
                    $size: "$likes"
                },
                owner: {
                    $first: "$owner" // overwrite
                },
                isLiked: {
                    $cond: {
                        if: {
                            $in: [req.user?._id, "$likes.likedBy"]
                        },
                        then: true,
                        else: false
                    }
                }
            },
        },
        {
            $project: {
                "videoFile.url": 1,
                title: 1,
                description: 1,
                views: 1,
                createdAt: 1,
                duration: 1,
                // comments: 1,
                owner: 1,
                likesCount: 1,
                isLiked: 1
            }
        }
    ])

    if (!video) {
        throw new ApiError(500, "failed to fetch video");
    }

    // increment views if video fetched successfully
    await Video.findByIdAndUpdate(videoId, {
        $inc: {
            views: 1
        }
    });

    //add video to user watch history
    await User.findByIdAndUpdate(req.user?._id, {
        $addToSet: {
            watchHistory: videoId
        }
    })

    return res
        .status(200)
        .json(new ApiResponse(200, video[0], "video details fetched successfully"))

})

// update video details like title, description, thumbnail
const updateVideo = asyncHandler(async (req, res) => {
    const { title, description } = req.body
    const { videoId } = req.params

    if (!videoId) {
        throw new ApiError(400, "Invalid video id")
    }

    if (!(title && description)) {
        throw new ApiError(400, "title and description are required");
    }

    const video = await Video.findById(videoId);

    if (!video) {
        throw new ApiError(404, "No video found");
    }

    if (video?.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't edit this video as you are not the owner"
        );
    }

    //deleting old thumbnail and updating with new one
    const thumbnailToDelete = video.thumbnail.public_id;

    const thumbnailLocalPath = req.file?.path;

    if (!thumbnailLocalPath) {
        throw new ApiError(400, "thumbnail is required");
    }

    const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);

    if (!thumbnail) {
        throw new ApiError(500, "error while updating thumbnail");
    }

    const updatedVideo = await Video.findByIdAndUpdate(
        videoId,
        {
            $set: {
                title,
                description,
                thumbnail: {
                    url: thumbnail.url,
                    public_id: thumbnail.public_id
                }
            }
        },
        {
            new: true
        }
    )

    if (!updatedVideo) {
        throw new ApiError(500, "Failed to update video please try again");
    }

    // deleting old thumbnail using public_id
    if (thumbnailToDelete) {
        await deleteOnCloudinary(thumbnailToDelete);
    }

    return res
        .status(200)
        .json(new ApiResponse(200, updateVideo, "Video updated succesfully"))

})

// delete video
const deleteVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    const video = await Video.findById(videoId)

    if (!video) {
        throw new ApiError(404, "No video found");
    }

    if (video.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't delete this video as you are not the owner"
        );
    }

    // const videoDeleted = await Video.findByIdAndDelete(videoId)
    // return the deleted document
    const videoDeleted = await Video.findByIdAndDelete(video?._id)
    console.log(videoDeleted);

    if (!videoDeleted) {
        throw new ApiError(400, "Failed to delete the video please try again");
    }

    await deleteOnCloudinary(video.thumbnail.public_id); // video model has thumbnail public_id stored in it->check videoModel
    await deleteOnCloudinary(video.videoFile.public_id, "video"); // specify video while deleting video

    // delete video likes
    const result = await Like.deleteMany({ video: videoId })
    if (result.acknowledged) {
        console.log(`Deleted ${result.deletedCount} likes.`);
    } else {
        console.log('Deletion was not acknowledged.');
    }
    
    // await Like.deleteMany({
    //     video: videoId
    // })

    // delete video comments
    await Comment.deleteMany({
        video: videoId
    })

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Video deleted successfully"));

})

// toggle publish status of a video
const togglePublishStatus = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    const video = await Video.findById(videoId)

    if (!video) {
        throw new ApiError(404, "Video not found");
    }

    if (video.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't toggle this video as you are not the owner"
        );
    }

    const toggledVideoPublish = await Video.findByIdAndUpdate(
        videoId,
        {
            $set: {
                isPublished: !video?.isPublished
            }
        },
        // return the updated document
        {
            new: true
        }
    )

    if (!toggledVideoPublish) {
        throw new ApiError(500, "Failed to toogle video publish status");
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { isPublished: toggledVideoPublish.isPublished },
                "Video publish toggled successfully"
            )
        )


})

export {
    getAllVideos,
    publishAVideo,
    getVideoById,
    updateVideo,
    deleteVideo,
    togglePublishStatus
}
