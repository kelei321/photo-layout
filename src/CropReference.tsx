import { cropRect, previewTileStyle, type Photo } from './model'
import PhotoView from './PhotoView'

export default function CropReference({ photo }: { photo: Photo }) {
  const { width, height } = photo.asset
  const bounds = previewTileStyle(cropRect(photo.asset, photo.crop), photo.asset)
  return <figure className="crop-reference">
    <div className="crop-original" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, ${128 * width / height}px)` }}>
      <PhotoView photo={photo} key={photo.asset.id} source={{ x: 0, y: 0, width, height }} />
      <div className="crop-frame" style={bounds} aria-hidden="true"><span className="head-guide" /></div>
    </div>
    <figcaption>原图 · 方框为裁切范围</figcaption>
  </figure>
}
