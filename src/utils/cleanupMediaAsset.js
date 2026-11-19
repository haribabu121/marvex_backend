import Carousel from '../models/Carousel.js'
import Gallery from '../models/Gallery.js'
import MediaAsset from '../models/MediaAsset.js'
import { destroyManagedAsset } from './cloudinaryMedia.js'

export async function cleanupMediaAsset(
  publicId,
  resourceType,
  { excludeCarouselId, excludeGalleryId } = {},
) {
  if (!publicId) return

  const [carouselRef, thumbnailRef, galleryRef] = await Promise.all([
    Carousel.exists({
      publicId,
      ...(excludeCarouselId ? { _id: { $ne: excludeCarouselId } } : {}),
    }),
    Carousel.exists({
      thumbnailPublicId: publicId,
      ...(excludeCarouselId ? { _id: { $ne: excludeCarouselId } } : {}),
    }),
    Gallery.exists({
      publicId,
      ...(excludeGalleryId ? { _id: { $ne: excludeGalleryId } } : {}),
    }),
  ])
  if (carouselRef || thumbnailRef || galleryRef) return

  await destroyManagedAsset(publicId, resourceType)
  await MediaAsset.deleteOne({ publicId })
}
